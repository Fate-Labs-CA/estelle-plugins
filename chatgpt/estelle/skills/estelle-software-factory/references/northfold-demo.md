# Northfold demo scenario

Northfold is the public sample storefront used on the Fate Labs homepage. This fixture is fictional and uses a simulated payment processor. No money moves.

## Source

- Repository: https://github.com/uqeu/estelle-demo-homepage
- Snapshot commit prefix: e3d28b31fc9a
- Structured fixture: [northfold-demo.json](northfold-demo.json)

The source at this snapshot calls payments.newAttemptKey() on each retry in shop/checkout.js. Two calls to retryCheckout for the same sample order produce two simulated charges. The desired behavior is to reuse order.paymentKey and produce one charge.

## Workflows to demonstrate

1. Ask Estelle for a plan to investigate duplicate charges in this repository, explicitly requesting no cloud work or code changes.
2. Ask for the synthetic team decision review_demo.checkout_retry_policy. The answer should identify it as sample data and describe stable payment identity.
3. Look up checkout retries through Atlas and source navigation. Cite actual returned files/pages; an unavailable outline or exact source is a setup failure, not a successful lookup.
4. Ask about production monitoring in the demo workspace. The sample issue is ReviewDemoDuplicateCharge in retryCheckout, environment openai-review-demo. Describe it as synthetic. The public-site uptime check is separate from the storefront and is not evidence that a hosted storefront is healthy.
5. Preview a bounded, read-only QA campaign for an explicitly supplied accessible target. Preview before spending, and read campaign results before saying any tests ran.

## Data and execution boundaries

A fixture describes expected setup; it is not a service response. The plugin does not automatically seed this data. Use a separate workspace with no private repositories or customer data. Keep repair auto-start off during reviewer rehearsals. Never embed passwords, API keys, account access details or customer records in this fixture.

A local npm test run on the pinned source passed six baseline tests during preparation. Those tests did not catch the retry defect: a separate one-charge assertion failed on the buggy checkout, while a reference control using the same payment key produced one charge. These are local demo observations, not a claim that every factory capability passed or that a production payment incident occurred.
