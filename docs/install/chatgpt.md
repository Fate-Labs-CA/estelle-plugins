# ChatGPT

Estelle for ChatGPT connects your own Estelle account to the hosted MCP server at `https://api.fatelabs.ca/mcp` over OAuth. It is a separate package from the coding-agent plugins: it has no hooks, no local runtime and no API key.

**Status:** prepared for OpenAI review, not yet submitted or listed. You cannot install it from the ChatGPT Plugins directory today.

## What is in the package

`chatgpt/estelle/` holds:

- `plugin.json`: listing text, links, starter prompts, five positive and three negative review cases, and the package version (`0.1.2`, versioned separately from the coding-agent plugins).
- `mcp.json`: the server URL and the OAuth declaration (`client.mode: "cimd"`, scopes `estelle:mcp` and `offline_access`). There is no client secret and no token in it.
- `assets/icon.png`: the 512×512 Fate Labs icon.
- `skills/`: four usage skills (engineering requests, review and QA, production operations, Atlas and team memory) and the public Northfold sample fixture used by the review cases.
- `REVIEW-RUNBOOK.md`: the owner's run sheet for testing in real ChatGPT. It is not part of the upload.

`npm run build` never touches `chatgpt/`; the coding-agent build only regenerates `plugins/` and its own manifests.

## Connect it yourself before it is listed

If your ChatGPT plan allows custom MCP servers:

1. Open **Plugins** in ChatGPT, select **+**, then **Add custom MCP server**.
2. Enter `https://api.fatelabs.ca/mcp` and choose OAuth. Leave the client and endpoint fields empty.
3. Continue, then sign in to **your own** Estelle account on the consent page and choose **Allow**.

Your Estelle plan and permissions decide what you can do. Metered work uses your Estelle credits; a ChatGPT subscription does not include them. Never paste an API key into ChatGPT.

## Build the upload ZIP (owner)

From a checkout of the commit you want to submit:

```sh
cd chatgpt/estelle
zip -r ../../estelle-chatgpt-0.1.2.zip plugin.json mcp.json assets skills
```

That puts `plugin.json` at the ZIP root and leaves out `REVIEW-RUNBOOK.md`. Then follow the submission steps at the end of the run sheet.

## Public boundary

Everything here is public: listing text, usage instructions, review prompts, the icon and the server address. The package contains no backend code, internal prompts, credentials, customer data or private repository paths, and `test/chatgpt-package.test.mjs` fails if any of those shapes appear.
