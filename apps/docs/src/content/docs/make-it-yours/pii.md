---
title: PII
description: Mark personal data by name, grant access and understand the query checks and their limits.
sidebar:
  order: 4
---

Mark personal data before people query it through the book. A person without `pii_reader` cannot see a marked column or measure in metadata, and a query that uses it is refused. Queries still run under that person's own Power BI rights.

## Rules by name

For the admin screen and the catalog's Mark PII control, see [PII in the browser](/docs/make-it-yours/pii-in-the-browser/).

An admin sets a rule with `pbmb admin pii` or the [REST API](/docs/reference/rest-api/). It applies to every table with that name, in every dataset, including datasets found later. There are no exceptions for individual datasets. Names match without case or character width differences.

| Kind | Reference | Covers |
|---|---|---|
| Column | `Customer[Customer]` | That column in every table named Customer. |
| Table | `Customer` | Every column of Customer, now and later. It does not cover measures. |
| Measure | `Sales[Net sales]` with `--measure` | That measure, wherever the table is copied. |

A column rule takes precedence over its table rule. For example, mark Customer as PII, then clear `Customer[Region]` to leave Region visible. Clearing records a review with `pii: false`; removing deletes the rule, so the table rule applies again.

```bash
pbmb admin pii mark Customer --note 'Customer details are personal data'
pbmb admin pii clear 'Customer[Region]' --note 'Region is safe to group by'
pbmb admin pii list --pii
pbmb admin pii list --cleared
pbmb admin pii remove 'Customer[Region]'
pbmb admin pii suggest --dataset Sales
```

These examples show the command forms. Suggestions never mark anything by themselves. Reviewed names stay out of suggestions. Suggestions and coverage counts use only datasets the admin can reach in Power BI, including off datasets. Each rule records who changed it, when and through which client. `pbmb admin export` includes rules in `book.yml`; `pbmb admin import` previews changes before applying them.

## Give a person access

`pii_reader` adds PII access to a person's normal role. Admins and curators need it too. Assign it only to a person or a group, never an email domain or everyone in the tenant. It cannot be the default role. Service accounts never read PII, even if a policy grants it.

Keep the normal role explicitly assigned: `access.default_role` applies only when no assignment matches. The sample check below shows both assignments. To revoke PII access, run `pbmb admin roles list`, then `pbmb admin roles revoke <assignment id>`. Roles are read on each request. The role does not grant Power BI access to a dataset. See [Roles and policies](/docs/make-it-yours/roles-and-policies/) for group assignments.

## What is hidden and refused

Without the role, marked columns and measures are absent from lists, counts, element descriptions, term backing columns, variants, drafts and threads on those elements. Relationships naming a marked column are hidden. `pii_hidden` reports how many items were hidden, when greater than zero. Asking for a hidden element answers as if it did not exist.

With the role, lists show the items with `pii: true`. Search never indexes marked columns or measures, for anyone, so use column and measure lists to find them.

A query naming a PII column or measure is refused before Power BI is called. A whole table reference, including `FILTER(Customer, ...)`, is refused if the table contains PII. Use explicit safe columns instead. For example, `EVALUATE VALUES(Customer[Customer])` is refused after the Customer column is marked:

```text
This query uses PII: Customer[Customer]. Use the table's other columns, or ask an admin for the pii_reader role.
```

The refusal is audited. If relationships needed for the check are not known yet, the query is refused with a request to try later or ask an admin for `pii_reader`.

## Limits

Rules refuse queries; they do not mask values or filter rows. Keep Power BI object level security where you use it. Rules apply only to requests through this product.

- A model measure that aggregates PII remains usable unless you mark the measure itself. For example, counting customers does not automatically make the count PII. A measure's DAX shown by `get_variant` and drafts can name a PII column, but never shows its values.
- Functions that read the whole model, including `COLUMNSTATISTICS`, `DETAILROWS` and INFO functions, are refused on a dataset with PII for someone without the role. `EXTERNALMEASURE` and possible alternate spellings of model readers are refused too.
- A column joined to a PII column by a relationship is treated as PII in queries. A table keyed by a PII value, such as an auto date table on a birth date, is treated as PII as a whole. These checks use the relationships known to the book.
- The result check after Power BI answers sees only unrenamed column keys. Renaming a result column can evade that check, so the check before the query is the one that counts. Power BI error messages are not checked for PII.
- Calculation group items and user functions have no rule kind and are not synced. Their indirect use of PII is not checked. If a tenant never answers INFO views, a newly added table whose foreign key carries PII is undetected until the next scan. Relationships read by one person are reused for other people's checks.
- An unsynced column whose name folds to a synced measure name on the same covered table can pass as that measure. Name matching and unusual DAX syntax need testing against your tenant; the automated checks use the sample mock.
- Changing a rule does not purge stored results. Only the person who ran a query can read its result, until expiry under `results.ttl_hours`, at most 72 hours. The query log keeps DAX, which can contain names and literal filter values, but no result rows. Other thread text is free text.

## Check on the sample tenant

Use a fresh sample deployment after its first sync, with separate admin and viewer logins. As the admin:

```bash
pbmb admin pii mark 'Customer[Customer]' --note 'Customer names are personal data'
pbmb admin pii list --pii
```

The mark command reports matched columns, measures and datasets. The list includes the Customer column rule. As `viewer@sample.example`, run:

```bash
pbmb dax run Sales --query 'DEFINE VAR customer_names = VALUES(Customer[Customer]) EVALUATE Customer'
```

The query is refused and names `Customer[Customer]` and the table Customer. As the admin, grant the role:

```bash
pbmb admin roles assign viewer --person viewer@sample.example
pbmb admin roles assign pii_reader --person viewer@sample.example
```

Run the same query as the viewer again. It returns the invented customer names. To undo the check, remove the rule and revoke the role assignment using its id from `roles list`.
