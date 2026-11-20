"""Estelle for Hermes Agent: one plugin.

Hermes runs a plugin's hooks as Python functions in its own process (hermes_cli/plugins.py, ``register(ctx)``). Each
hook here writes one envelope and hands it to the same ``runtime/cli.mjs hook hermes`` runner every other host uses, in
a child Node process: one runner, one key from the environment, and a failure there never takes Hermes down.

Hermes keeps its sessions in SQLite and names no transcript file to a plugin, so after each turn this plugin appends
the turn's messages (``conversation_history`` from ``post_llm_call``) to a JSONL mirror in Claude Code's line shape,
which ``runtime/stream.mjs`` and ``runtime/checkpoint.mjs`` already read. Append-only: the stream's cursor is a byte
offset into that file.

Written against hermes-agent 0.19.0 (PyPI) and read against v0.23.3 (GitHub). The MCP server itself is Hermes's own
configuration (``hermes mcp add``), because a plugin cannot register one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent
HOST = "hermes"
# The runner's own network deadline is 12 s (runtime/io.mjs); these are the outer bounds, as on the other hosts.
HOOK_TIMEOUT_S = 20
END_TIMEOUT_S = 3
MAX_OUTPUT_BYTES = 1_000_000
MAX_TOOL_OUTPUT_CHARS = 4_000
MAX_MIRROR_MESSAGES = 2_000
MAX_MESSAGE_CHARS = 100_000
MAX_SEED_BYTES = 8_000_000
MAX_SESSIONS = 256
MAX_ASSET_FILES = 64
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
COMMAND_FILE = re.compile(r"^---\ndescription: (.+)\n---\n([\s\S]+)$")
SKILL_NAME = re.compile(r"^[a-zA-Z0-9_-]+$")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_hook(event: str, payload: dict[str, Any], timeout: float = HOOK_TIMEOUT_S,
             runner: Callable[..., Any] | None = None) -> dict[str, Any] | None:
    """The runner's JSON answer, or None. Never raises: a hook that fails leaves its own status for ``doctor``."""
    body = json.dumps({"hook_event_name": event, **payload}).encode("utf-8")
    command = [os.environ.get("ESTELLE_NODE") or "node", str(ROOT / "runtime" / "cli.mjs"), "hook", HOST]
    try:
        done = (runner or subprocess.run)(command, input=body, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    lines = [line for line in done.stdout[:MAX_OUTPUT_BYTES].decode("utf-8", "replace").splitlines() if line.strip()]
    if not lines:
        return None
    try:
        answer = json.loads(lines[-1])
    except ValueError:
        return None
    return answer if isinstance(answer, dict) else None


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(part.get("text", "") for part in value if isinstance(part, dict) and part.get("type") == "text")
    return ""


def _uuid(session_id: str, index: int, message: dict[str, Any], part: str) -> str:
    digest = hashlib.sha1(json.dumps(message, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:12]
    return f"hermes-{session_id}-{index}-{digest}{part}"


def _arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else {}
    except ValueError:
        return {"arguments": str(raw)[:MAX_MESSAGE_CHARS]}
    return parsed if isinstance(parsed, dict) else {"arguments": parsed}


def lines_for(session_id: str, index: int, message: Any, at: str) -> list[dict[str, Any]]:
    """The mirror lines one OpenAI-shaped Hermes message contributes. Pure: message in, lines out."""
    if not isinstance(message, dict):
        return []
    role = message.get("role")
    line = lambda kind, part, content: {"type": kind, "uuid": _uuid(session_id, index, message, part), "timestamp": at,
                                        "message": {"role": kind, "content": content}}
    if role == "user":
        text = _text(message.get("content")).strip()
        return [line("user", "", [{"type": "text", "text": text[:MAX_MESSAGE_CHARS]}])] if text else []
    if role == "tool":
        return [line("user", ":result", [{"type": "tool_result", "tool_use_id": str(message.get("tool_call_id") or ""),
                                          "is_error": False, "content": _text(message.get("content"))[:MAX_MESSAGE_CHARS]}])]
    if role != "assistant":
        return []
    out = []
    text = _text(message.get("content")).strip()
    if text:
        out.append(line("assistant", "", [{"type": "text", "text": text[:MAX_MESSAGE_CHARS]}]))
    for position, call in enumerate((message.get("tool_calls") or [])[:MAX_ASSET_FILES]):
        function = call.get("function") if isinstance(call, dict) else None
        if not isinstance(function, dict) or not function.get("name"):
            continue
        out.append(line("assistant", f":call{position}", [{"type": "tool_use", "id": str(call.get("id") or ""),
                                                          "name": str(function["name"]), "input": _arguments(function.get("arguments"))}]))
    return out


def _seed(path: Path) -> set[str]:
    ids: set[str] = set()
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - MAX_SEED_BYTES))
            tail = handle.read(MAX_SEED_BYTES)
    except FileNotFoundError:
        return ids
    for raw in tail.decode("utf-8", "replace").splitlines():
        try:
            uuid = json.loads(raw).get("uuid")
        except (ValueError, AttributeError):
            continue  # A partial first line.
        if isinstance(uuid, str):
            ids.add(uuid)
    return ids


def sync_mirror(path: Path, session_id: str, history: Any, written: set[str], turn_id: str = "") -> int:
    """Append what is new for this session and mark the turn's end. ``written`` is seeded from the file once."""
    if not written:
        written.update(_seed(path))
        written.add("")  # Seeded, even when the file was empty.
    at = _now()
    fresh = []
    messages = history[-MAX_MIRROR_MESSAGES:] if isinstance(history, list) else []
    offset = len(history) - len(messages) if isinstance(history, list) else 0
    for index, message in enumerate(messages, start=offset):
        for item in lines_for(session_id, index, message, at):
            if item["uuid"] not in written:
                written.add(item["uuid"])
                fresh.append(item)
    end = f"hermes-{session_id}-{turn_id or len(history or [])}:turn-end"
    if fresh and end not in written:
        written.add(end)
        fresh.append({"type": "system", "subtype": "turn_duration", "uuid": end, "timestamp": at})
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path, "a", encoding="utf-8", opener=lambda p, f: os.open(p, f, 0o600)) as handle:
        handle.write("".join(json.dumps(item) + "\n" for item in fresh))
    return len(fresh)


def read_commands(root: Path = ROOT) -> list[dict[str, str]]:
    """The shared Estelle commands (commands/*.md) with the runner path filled in."""
    cli = str(root / "runtime" / "cli.mjs").replace('"', '\\"')
    out = []
    for file in sorted((root / "commands").glob("*.md"))[:MAX_ASSET_FILES]:
        match = COMMAND_FILE.match(file.read_text(encoding="utf-8"))
        if match:
            out.append({"name": file.stem, "description": match.group(1),
                        "template": match.group(2).replace("<Estelle cli.mjs>", cli)})
    return out


def read_skills(root: Path = ROOT) -> list[dict[str, Any]]:
    out = []
    for skill in sorted((root / "skills").glob("*/SKILL.md"))[:MAX_ASSET_FILES]:
        found = re.search(r"^description: (.+)$", skill.read_text(encoding="utf-8")[:4_000], re.MULTILINE)
        if SKILL_NAME.match(skill.parent.name):
            out.append({"name": skill.parent.name, "path": skill, "description": (found.group(1) if found else "").strip('"')})
    return out


class Estelle:
    """Per-process state for one Hermes run: start text and mirror cursors, bounded by MAX_SESSIONS."""

    def __init__(self, home: Path, runner: Callable[..., Any] | None = None, cwd: Callable[[], str] | None = None):
        self.home = home
        self.runner = runner
        self.cwd = cwd or os.getcwd
        self.start: dict[str, str] = {}
        self.introduced: dict[str, bool] = {}
        self.written: dict[str, set[str]] = {}
        self.instructions = (ROOT / "instructions.md").read_text(encoding="utf-8") if (ROOT / "instructions.md").exists() else ""

    def mirror(self, session_id: str) -> Path:
        if not SESSION_ID.match(session_id):
            raise ValueError("session_missing")
        return self.home / "estelle" / "transcripts" / f"hermes-{session_id}.jsonl"

    def _envelope(self, session_id: Any, parent: Any = None, **extra: Any) -> dict[str, Any] | None:
        if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
            return None
        envelope = {"session_id": session_id, "cwd": self.cwd(), "transcript_path": str(self.mirror(session_id)), **extra}
        if isinstance(parent, str) and SESSION_ID.match(parent):
            envelope["parent_session_id"] = parent
        return envelope

    def _hook(self, event: str, session_id: Any, timeout: float = HOOK_TIMEOUT_S, **extra: Any) -> dict[str, Any]:
        envelope = self._envelope(session_id, **extra)
        return (run_hook(event, envelope, timeout, self.runner) or {}) if envelope else {}

    def _remember(self, table: dict[str, Any], key: str, value: Any) -> None:
        if key not in table and len(table) >= MAX_SESSIONS:
            table.pop(next(iter(table)))
        table[key] = value

    def on_session_start(self, session_id: Any = None, model: Any = None, parent_session_id: Any = None, **_: Any) -> None:
        answer = self._hook("on_session_start", session_id, parent=parent_session_id,
                            model=model if isinstance(model, str) else None)
        if isinstance(session_id, str):
            self._remember(self.start, session_id, answer.get("additionalContext") or "")

    def pre_llm_call(self, session_id: Any = None, user_message: Any = None, parent_session_id: Any = None,
                     **_: Any) -> dict[str, str] | None:
        """Recall for this prompt. The first turn also carries Estelle's instructions and this session's start text."""
        prompt = _text(user_message)
        answer = self._hook("pre_llm_call", session_id, parent=parent_session_id, prompt=prompt) if prompt.strip() else {}
        first = isinstance(session_id, str) and session_id not in self.introduced
        if first:
            self._remember(self.introduced, session_id, True)
        parts = [self.instructions, self.start.pop(session_id, "")] if first else []
        parts.append(answer.get("additionalContext") or "")
        context = "\n\n".join(part for part in parts if part and part.strip())
        return {"context": context} if context else None

    def pre_tool_call(self, tool_name: Any = None, args: Any = None, session_id: Any = None, tool_call_id: Any = None,
                      parent_session_id: Any = None, **_: Any) -> None:
        if not isinstance(tool_name, str):
            return
        answer = self._hook("pre_tool_call", session_id, parent=parent_session_id, tool_name=tool_name,
                            tool_input=args if isinstance(args, dict) else {},
                            tool_use_id=tool_call_id if isinstance(tool_call_id, str) else None)
        warning = answer.get("warning")
        if isinstance(warning, str) and warning:
            print(warning, file=sys.stderr)
        return  # A warning, never a block.

    def post_tool_call(self, tool_name: Any = None, args: Any = None, result: Any = None, session_id: Any = None,
                       tool_call_id: Any = None, status: Any = None, parent_session_id: Any = None, **_: Any) -> None:
        if not isinstance(tool_name, str):
            return
        self._hook("post_tool_call", session_id, parent=parent_session_id, tool_name=tool_name,
                   tool_input=args if isinstance(args, dict) else {},
                   tool_use_id=tool_call_id if isinstance(tool_call_id, str) else None,
                   tool_response={"output": str(result or "")[:MAX_TOOL_OUTPUT_CHARS], "is_error": status == "error"})

    def post_llm_call(self, session_id: Any = None, conversation_history: Any = None, turn_id: Any = None,
                      parent_session_id: Any = None, **_: Any) -> None:
        """The turn ended: write it to the mirror, then let the runner stream and checkpoint it."""
        if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
            return
        written = self.written.get(session_id)
        if written is None:
            written = set()
            self._remember(self.written, session_id, written)
        try:
            sync_mirror(self.mirror(session_id), session_id, conversation_history, written,
                        turn_id if isinstance(turn_id, str) else "")
        except OSError as error:
            logger.warning("Estelle could not write its session mirror: %s", error)
            return
        self._hook("post_llm_call", session_id, parent=parent_session_id)

    def on_session_finalize(self, session_id: Any = None, **_: Any) -> None:
        self._hook("on_session_finalize", session_id, END_TIMEOUT_S)


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except (ImportError, AttributeError, OSError):  # Outside Hermes (tests, a plain import): its documented default.
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _session_cwd(ctx: Any) -> Callable[[], str]:
    """The session's recorded cwd where Hermes offers it (``ctx.session_cwd``, v0.23), else this process's."""
    recorded = getattr(ctx, "session_cwd", None)

    def cwd() -> str:
        try:
            value = recorded() if callable(recorded) else ""
        except Exception:  # noqa: BLE001 - any failure in the host's lookup falls back to the process cwd.
            value = ""
        return value if isinstance(value, str) and os.path.isabs(value) else os.getcwd()
    return cwd


def register(ctx: Any, estelle: Estelle | None = None) -> Estelle:
    """Hermes calls this once per process with its PluginContext."""
    plugin = estelle or Estelle(_hermes_home(), cwd=_session_cwd(ctx))
    for name in ("on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_finalize"):
        ctx.register_hook(name, getattr(plugin, name))
    for skill in read_skills():
        try:
            ctx.register_skill(skill["name"], skill["path"], skill["description"])
        except (ValueError, FileNotFoundError) as error:
            logger.warning("Estelle skill %s was not registered: %s", skill["name"], error)
    for command in read_commands():
        ctx.register_command(f"estelle-{command['name']}", _command(ctx, command), command["description"], "[what you want]")
    return plugin


def _command(ctx: Any, command: dict[str, str]) -> Callable[[str], str | None]:
    """``/estelle-<name> words`` becomes the shared command's prompt, sent as the person's own next message."""
    def handler(raw_args: str = "") -> str | None:
        prompt = command["template"].replace("$ARGUMENTS", (raw_args or "").strip())
        if ctx.inject_message(prompt):
            return None
        return f"Estelle could not start /estelle-{command['name']} here. Send this as your message instead:\n\n{prompt}"
    return handler
