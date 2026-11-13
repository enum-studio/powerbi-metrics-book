---
title: Make it yours
description: Conventions and presets, custom fields, roles and policies, sign-in providers, the change feed and building on the API.
sidebar:
  order: 0
  label: Overview
---

This part shows how to change what the product does without forking it. It is for the admin or engineer who adapts the book to the company's rules and builds the company's own tools on top.

Every opinion in the product is a default, and each has a place to change it:

| To change | Where |
|---|---|
| Names, the description shape, variant axes, how drafts are grouped, what verification needs | [Conventions and presets](/docs/make-it-yours/conventions/) |
| Extra fields on metrics, terms, datasets, tables, columns and measures | [Custom fields](/docs/make-it-yours/custom-fields/) |
| Who may see and do what, and new roles | [Roles and policies](/docs/make-it-yours/roles-and-policies/) |
| Which columns and measures contain personal data | [PII](/docs/make-it-yours/pii/) |
| How people sign in | [Sign-in providers](/docs/make-it-yours/sign-in-providers/) |
| What happens when the book changes | [The change feed](/docs/make-it-yours/change-feed/) |
| Your own tools, screens and MCP tools | [Building on the API](/docs/make-it-yours/building-on-the-api/), with the [REST API reference](/docs/reference/rest-api/) |

A few rules are not settings, because they are what makes the stack safe to run. [What is not a setting](/docs/make-it-yours/what-is-not-a-setting/) lists them and says why.

Do the [Set up](/docs/set-up/) part first: these pages assume a running stack with an admin and a signed-in `pbmb` (`pbmb login`). Each page ends with a command that shows the change worked.
