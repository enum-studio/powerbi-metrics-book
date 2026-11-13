---
title: Security
description: What an evaluator needs to judge the stack, the threat model, how secrets and tokens are stored, what leaves the stack, and how to report a vulnerability.
sidebar:
  order: 0
  label: Overview
---

This part is for whoever has to decide whether the stack may run in their company, and for anyone who finds a flaw. It says what the stack protects, from whom, which control holds each boundary and which test proves it.

Read it in this order:

1. [The evaluator's checklist](/docs/security/checklist/): thirteen controls, each with the test that proves it and a command to check it yourself.
2. [Sign-in](/docs/security/sign-in/): your company chooses how people sign in.
3. [The threat model](/docs/security/threat-model/): assets, attackers, trust boundaries and residual risks.
4. [Secrets and tokens](/docs/security/secrets-and-tokens/): where each is kept, who can read it, backups, rotation and expiry.
5. [What leaves the stack](/docs/security/what-leaves-the-stack/): every outbound host and what each call carries.
6. [Reporting a vulnerability](/docs/security/reporting/): privately, through GitHub security advisories.
