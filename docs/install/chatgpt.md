# ChatGPT

Estelle is an autonomous AI software factory for self-healing software. This package connects ChatGPT to the hosted service at https://api.fatelabs.ca/mcp.

## Package source

The standalone OpenAI package lives in `chatgpt/estelle/`. Its four skills cover the software factory, QA and review, production operations, and Atlas and team memory. The package includes listing metadata, five positive and three negative review cases, and an icon. It has no local hooks or runtime.

This is preparation source, not an approved public listing or a verified ChatGPT installation. The ChatGPT package version lives in `chatgpt/estelle/plugin.json`, independently of the coding-agent hook packages.

The [Northfold sample scenario](../../chatgpt/estelle/skills/estelle-software-factory/references/northfold-demo.md) describes the public storefront, synthetic decision and monitor event used during review preparation. The fixture contains no account credentials and does not seed itself into an account.

## Build the ZIP

From a checkout of the commit you want to package:

```sh
git archive --format=zip --output=estelle-chatgpt.zip HEAD:chatgpt
```

The ZIP contains one `estelle/` directory. Inspect it before upload. The portable plugin and MCP manifests must validate against their declared Agent Plugins schemas; that check does not validate OpenAI review metadata or establish that sign-in works.

## Prepare public review

1. Confirm the listing and verified publisher are Fate Labs. Country targeting is explicitly unrestricted; service plans are purchased on fatelabs.ca.
2. Provide a dedicated reviewer account and sample repository, team decision and monitoring data. Reviewer credentials belong only in secure portal fields.
3. Prepare and verify a real demo recording and put its accessible URL in `extensions.com.openai.review.demo_recording_url`. It is currently absent. Do not call this ZIP submission-ready until the recording and other review requirements are complete.
4. Verify the server advertises boolean readOnlyHint, openWorldHint and destructiveHint annotations for every tool. Test actual OAuth connection and each review case against the saved version.
5. Once preparation is complete, upload through the intended OpenAI developer organization's plugin submission flow, complete the MCP connection, required scans and developer attestations, then submit for review. Approval and publication are separate actions.

A ChatGPT connection uses OAuth discovery from the hosted server. No credentials or fixed client secret are packaged. An endpoint responding is not proof of completed OAuth or access to every service. The connected account determines available actions. If a tool requires approval, use the host's supported approval flow.

## Update it

For service implementation changes, use the existing Estelle backend release process. For listing, skill, icon or connection changes, edit this package, increment its version, rebuild and inspect the ZIP, and use the existing plugin identity and intended organization's update flow. Do not create a second plugin to update an existing one.

Before replacing a saved submission, inspect it: full ZIP replacement resets attestations, and changes during review may require cancellation. Retain Portal-generated App bindings in saved releases; public author-supplied ZIPs contain the MCP declaration rather than private App bindings.

## Public boundary

These are public client files: listing text, usage instructions, review prompts, branding and the server address. Anyone can read and copy these instructions. This package includes no factory backend, internal agent/model prompts, inference implementation, credentials, customer data or deployment configuration. Changes to this directory should preserve that boundary.

The coding-agent package builder regenerates `plugins/`. ChatGPT source deliberately lives outside that generated tree.
