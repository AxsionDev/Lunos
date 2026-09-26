# Data protection (GDPR)

**Status: under legal review, not yet published.** The data-protection note (who is controller and
processor, which personal data reaches model providers, and a DPIA-support checklist for customers)
is being reviewed by ITService EOOD's counsel and will be published here once approved.

What can be stated from the product documentation today, without legal interpretation:

- Lunos is software you run on your own infrastructure. ITService EOOD operates no service in the
  data path and receives no data from your deployment: no account, no telemetry
  ([deployment guide §3](../deployment/self-hosted.md#3-where-your-data-goes)).
- What leaves your infrastructure is the model requests you make, to the provider **you** configure,
  under **your** agreement with it. The data-residency policy restricts which providers may be used
  and records every call ([data residency](../data-residency.md)).
- Session sharing, which would upload a transcript, is off by default.
