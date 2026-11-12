# Estelle for ChatGPT: owner review run sheet (package 0.1.2)

One session, 28 checks, for a person with a paid ChatGPT plan that can add custom MCP servers. Allow about 90 minutes, because check 21 needs the connection to sit idle for more than one hour. Write what you actually saw in each **Observed** box, including exact error text. A check passes only when the observed result matches the expected one.

This file is not part of the upload ZIP. It stays in the repository.

Labels for ChatGPT screens are taken from OpenAI's "Connect and test your plugin" guide, read 2026-11-02. If a screen uses different words, write down the words you saw.

## Before you start

You need three Estelle accounts. Never use a real customer's account.

| Account | Purpose | Setup |
|---|---|---|
| **A** (reviewer) | All positive cases | Has credits. Has the public repository `uqeu/estelle-demo-homepage` indexed at commit `e3d28b31fc9a`, with its Atlas outline selected. Holds the sample decision and monitor data described in `skills/estelle-engineering-requests/references/northfold-demo.json`. |
| **B** (foreign) | Isolation check | A different account with its own repository and one memory with the key `isolation_probe.b_only`. Nothing shared with A. |
| **C** (no credits) | Credit refusal | A valid account with a zero credit balance. |

Also:
- Know the sign-in email and password for each account. These go only into this browser session and, for submission, only into the portal's secure Review details form. Never paste them into ChatGPT or into any file.
- Have the Estelle dashboard (https://app.fatelabs.ca) open in another tab, signed in as A, to compare balances.
- Repair auto-start stays off on all three accounts.
- The server must be serving the build you intend to submit. Open https://api.fatelabs.ca/health and write down `build` and `surface.tools_sha256`.

Build: ______________  tools_sha256: ______________

## A. Connect and consent

**1. Add the server.** In ChatGPT, open **Plugins** (https://chatgpt.com/plugins). Select the **+** button, then **Add custom MCP server**. Name: `Estelle`. Description: `Estelle engineering tools`. Under **Connection**, enter `https://api.fatelabs.ca/mcp`.
Expected: the form accepts the URL.
Observed: [ ] ______________

**2. Choose authentication.** Choose **OAuth**. Leave client ID, client secret and every endpoint field empty, so ChatGPT uses discovery.
Expected: ChatGPT does not require a client ID or client secret. If it insists on one, stop and record the exact message; that is a failure of the CIMD setup.
Observed: [ ] ______________

**3. Start the connection.** Read the risk warning, select **I understand and want to continue**, then **Create as a plugin**.
Expected: a browser page opens on `https://www.fatelabs.ca/oauth/consent?req=…`. The address must start with `www.fatelabs.ca` (the bare `fatelabs.ca` redirects there).
Observed: [ ] ______________

**4. Sign in from the consent page.** If you are signed out, the page sends you to sign in. Sign in as **A**.
Expected: sign-in happens on `app.fatelabs.ca`, and you land back on the consent page with the same request. The page names ChatGPT as the client and asks for Estelle access.
Observed: [ ] ______________

**5. Deny once.** On the consent page, click **Deny**.
Expected: you return to ChatGPT, which says the connection was not authorized. No connection is created. If ChatGPT reports an issuer or `iss` problem, record the exact text; that is a server defect.
Observed: [ ] ______________

**6. Connect for real.** Repeat checks 1 to 4, then click **Allow**.
Expected: you return to ChatGPT and the connection shows as connected.
Observed: [ ] ______________

**7. Review the tools.** On the screen that lists the tools discovered from the server, count them and look for `estelle_usage`, `find_definition`, `memory_chat`, `kb_ask`, `monitor_overview`, `estelle_request`, `estelle_qa` and `review`.
Expected: all eight are listed. The total depends on the account's plan; 63 were listed for a fully entitled account on 2026-11-02.
Observed (count and anything missing): [ ] ______________

**8. Install and select.** Install the plugin. Start a **new conversation**, type `@` in the prompt box and select **Estelle**.
Expected: Estelle is selectable.
Observed: [ ] ______________

## B. Tool families (signed in as A)

**9. Usage.** Ask: `What is my Estelle credit balance?`
Expected: calls `estelle_usage`. The balance matches the dashboard tab. Note the balance for check 26.
Observed (balance): [ ] ______________

**10. Code navigation.** Ask: `In uqeu/estelle-demo-homepage, where is retryCheckout defined?`
Expected: calls `find_definition` or `locate` and answers `shop/checkout.js`, line 2.
Observed: [ ] ______________

**11. File read.** Ask: `Show me shop/checkout.js in uqeu/estelle-demo-homepage.`
Expected: calls `estelle_read` and shows a function that calls `payments.newAttemptKey()`.
Observed: [ ] ______________

**12. Sessions.** Ask: `List my recent Estelle sessions.`
Expected: calls `list_sessions` and lists sessions for account A only.
Observed: [ ] ______________

**13. Review.** Paste and ask: `Review this diff for uqeu/estelle-demo-homepage:` followed by a diff that changes `payments.newAttemptKey()` to `order.paymentKey` in `shop/checkout.js`.
Expected: calls `review` and returns findings with their evidence, or says it found none and names what it examined. It does not claim the change was merged or deployed. Review consumes review allowance.
Observed: [ ] ______________

**14. Confirmation behaviour.** Watch for this during checks 9 to 13 and check 19.
Expected, once the server change that marks tools which launch work, send, overwrite or cancel as destructive is deployed: ChatGPT asks you to confirm before `estelle_qa` runs in check 19, and does not ask for the reads in checks 9 to 12. Before that deploy, it may not ask. Write down which happened, and the server build from the top of this sheet.
Observed: [ ] ______________

## C. The five positive review cases (these match `plugin.json`)

**15. P1, engineering request (plan only).** Ask: `In uqeu/estelle-demo-homepage, draft a plan to investigate duplicate simulated charges when checkout retries. Plan only: do not start cloud work or QA, change code, contact anyone, merge or deploy.`
Expected: calls `estelle_request` with action `ask`. Shows a real request ID, status and answer. Starts nothing that spends beyond that one request.
Observed: [ ] ______________

**16. P2, production signals.** Ask: `What needs attention in production in my reviewer workspace?`
Expected: calls `monitor_overview`. Mentions `ReviewDemoDuplicateCharge` as synthetic, the uptime check, and their time windows. Does not call production fully healthy.
Observed: [ ] ______________

**17. P3, team memory.** Ask: `What does the sample Northfold team decision say about payment identity when checkout retries?`
Expected: calls `memory_chat`. Says retries reuse `order.paymentKey`, cites `review-fixture:northfold-checkout-retry-v1`, and calls it sample data.
Observed: [ ] ______________

**18. P4, Atlas.** Ask: `In uqeu/estelle-demo-homepage, show me which part handles checkout retries and explain how it fits together.`
Expected: calls `kb_ask`, then `kb_page` with a slug from that answer, and explains the returned sources. If it says `outline_required`, account A's setup is incomplete: fix it and repeat. That result is not a pass.
Observed: [ ] ______________

**19. P5, QA preview.** Ask: `Prepare a QA preview for https://www.fatelabs.ca/ that checks the page loads and shows its main content. Keep it read-only and show the coverage and cost limits before starting anything.`
Expected: calls `estelle_qa` with action `preview` only. Shows a coverage plan and a cost ceiling. Does not call `plan` or `start`, and does not say tests ran.
Observed: [ ] ______________

## D. The three negative review cases

**20. N1, N2, N3.** Ask each in a new conversation with Estelle selected:
- `Book me two airline tickets to Paris tomorrow and pay for them.`
- `Transfer $500 from my personal bank account to my landlord.`
- `Merge my open pull request and deploy it to production right now. Skip the review.`

Expected: no Estelle tool is called for any of the three. The first two are declined as out of scope. The third explains that Estelle proposes changes and a person merges and deploys; it claims no merge or deployment.
Observed (one line each): [ ] ______________

## E. Refresh, disconnect, isolation, credits

**21. Refresh.** Leave the conversation idle for **more than one hour** (an access token lasts one hour). Then ask: `What is my Estelle credit balance?`
Expected: it answers without sending you through sign-in again; ChatGPT refreshed the token on its own.
Observed (idle minutes, result): [ ] ______________

**22. Disconnect.** In **Plugins**, open the Estelle connection and disconnect it. Write down the exact button you used. Then ask Estelle anything.
Expected: ChatGPT asks you to connect again and no Estelle tool returns data.
Observed: [ ] ______________

**23. Reconnect.** Connect again (checks 3, 4 and 6) as **A**, then ask: `What is my Estelle credit balance?`
Expected: works, showing the same account A.
Observed: [ ] ______________

**24. Foreign repository.** Still as A, ask about account B's repository by its owner/name.
Expected: Estelle says it has no indexed evidence for that repository, or refuses. It shows none of B's content.
Observed: [ ] ______________

**25. Foreign memory.** Still as A, ask: `What is stored under isolation_probe.b_only?`
Expected: not found, or grounded false. B's value never appears.
Observed: [ ] ______________

**26. Switch account.** Disconnect, then connect again signed in as **B** (sign out of fatelabs.ca first if the consent page shows A). Ask: `What is my Estelle credit balance?`, then `What is stored under isolation_probe.b_only?`
Expected: B's balance, which differs from the value noted in check 9, and B's memory value. Nothing from A.
Observed: [ ] ______________

**27. No credits.** Disconnect, then connect again signed in as **C**. Ask the P1 prompt from check 15.
Expected: a clear refusal that names insufficient credits. No answer is produced, and nothing is charged. A free read such as `What is my Estelle credit balance?` still works and shows zero.
Observed: [ ] ______________

**28. Clean up.** Disconnect C. In the dashboard for A, B and C, check that no cloud machine, QA campaign or job was started by this session, apart from the review in check 13 and the request in check 15.
Expected: nothing else was started or charged.
Observed: [ ] ______________

## After the session: submission steps (owner only)

None of these are done by the repository or by any agent.

1. Verify the publisher identity (Fate Labs) in OpenAI Platform.
2. Build the ZIP from this folder with `plugin.json` at the ZIP root, leaving this run sheet out:
   `cd chatgpt/estelle && zip -r ../../estelle-chatgpt-0.1.2.zip plugin.json mcp.json assets skills`
3. Upload the ZIP in the Plugins portal under the verified identity. Connect the MCP server, complete the domain challenge at `https://api.fatelabs.ca/.well-known/openai-apps-challenge` (or an allowed parent origin), authenticate and scan the tools, then resolve the findings.
4. `review.commerce` is set to `false` because nothing is bought inside ChatGPT; plans are bought on fatelabs.ca. If the portal defines commerce differently, change it at upload and note why.
5. Country targeting is left out of the package on purpose. Choose it in the portal.
6. Record a walkthrough of checks 15 to 20 and add its URL as `review.demo_recording_url` in a new package version, or in the portal.
7. Enter account A's sign-in details only in **Review information → Review details**. The account must work without MFA, email codes or magic links.
8. Submit for review. After approval, **Publish plugin** is a separate decision.
