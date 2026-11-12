# Northfold sample scenario

Northfold is the public sample storefront used on the Fate Labs homepage. It is fictional and uses a simulated payment processor. No money moves.

## Source

- Repository: https://github.com/uqeu/estelle-demo-homepage
- Snapshot commit prefix: e3d28b31fc9a
- Structured fixture: [northfold-demo.json](northfold-demo.json)

At this snapshot, `shop/checkout.js` calls `payments.newAttemptKey()` on each retry, so two calls to `retryCheckout` for the same sample order produce two simulated charges. The intended behaviour is to reuse `order.paymentKey` and produce one charge.

## What the review walks through

1. Ask Estelle for a plan to investigate the duplicate charges, explicitly with no cloud work and no code change.
2. Ask for the sample team decision `review_demo.checkout_retry_policy`. The answer should identify it as sample data and describe a stable payment identity.
3. Look up checkout retries through Atlas and code navigation. Cite the files or pages actually returned; a missing outline is a setup failure, not a result.
4. Ask about production in the sample workspace. The sample issue is `ReviewDemoDuplicateCharge` in `retryCheckout`, environment `openai-review-demo`, and it is synthetic. The public-site uptime check is separate from the storefront and says nothing about a hosted storefront.
5. Preview a bounded, read-only QA campaign for an accessible target. Preview before anything is spent, and read results before saying any test ran.

## Boundaries

This fixture describes the expected setup; it is not a service response. Installing the plugin does not load this data into any account. Use a separate workspace with no private repositories or customer data, and keep repair auto-start off while rehearsing. This file contains no passwords, keys, account access details or customer records.
