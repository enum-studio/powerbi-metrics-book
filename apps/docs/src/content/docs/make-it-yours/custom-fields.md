---
title: Custom fields
description: Add your own fields to metrics, terms, datasets, tables, columns and measures, and your own axes to variants.
sidebar:
  order: 2
---

Custom fields let the book carry facts that are yours: who owns a metric, which system it comes from, whether a dataset may be queried. You declare a field in the conventions, set it on elements, and then read it in every answer and filter by it. No code changes.

## Declare a field

A field has a key, a label and a type. The key is lowercase letters, digits and underscores, starting with a letter, and unique in its list.

| Type | Holds |
|---|---|
| `text` | Any text. |
| `number` | A number. |
| `boolean` | `true` or `false`. |
| `date` | A date written `YYYY-MM-DD`. |
| `choice` | One of a list you give in `values`. Only a `choice` field has `values`. |

Add `required: true` to make the checks fail while the field is empty. The default is optional.

Where you declare it decides what it attaches to:

| Conventions key | Attaches to |
|---|---|
| `metric_fields.custom` | Metrics. |
| `term_fields.custom` | Terms. |
| `element_fields.custom` | Datasets, tables, columns and measures. |
| `variants.axes.custom` | Variants, as an axis (below). |

This file adds an owner team, a source system and a review date to metrics, a switch to datasets, and a market axis to variants:

```yaml
metric_fields:
  custom:
    - { key: owner_team, label: Owner team, type: text }
    - { key: source_system, label: Source system, type: choice, values: [erp, webshop, crm], required: true }
    - { key: reviewed_on, label: Reviewed on, type: date }
element_fields:
  custom:
    - { key: queries_off, label: Queries off, type: boolean }
variants:
  axes:
    custom:
      - { key: market_scope, values: [all_markets, home_market] }
```

Apply it without losing your other rules by changing one list at a time. A list you set replaces the old one, so include the fields already there:

```bash
pbmb conventions set metric_fields.custom '[{"key":"owner_team","label":"Owner team","type":"text"},{"key":"source_system","label":"Source system","type":"choice","values":["erp","webshop","crm"],"required":true}]'
pbmb conventions set element_fields.custom '[{"key":"queries_off","label":"Queries off","type":"boolean"}]'
```

For several changes, use `pbmb conventions edit`. [Conventions](/docs/make-it-yours/conventions/) has the other commands.

## Set a value

| On | How |
|---|---|
| A metric | `pbmb metrics update total_net_sales_excl_vat --custom owner_team=finance --custom source_system=erp` |
| A term | `pbmb terms update Channel --custom owner_team=marketing` |
| A variant, for an axis | `pbmb variants move <id> --to <metric> --axis market_scope=home_market` |
| A dataset, table, column or measure | The REST route below. |

`--custom` reads a value as JSON when it is JSON (`true`, `3`, `["a"]`) and as text otherwise. Write `"42"` for the text 42.

A dataset, table, column or measure takes its custom fields through `PUT /api/v1/elements/{kind}/{id}/docs`, with a JSON body. The `custom` object you send replaces the whole old one:

```bash
curl -X PUT "$PBMB_URL/api/v1/elements/dataset/<dataset id>/docs" \
  -H "Authorization: Bearer $PBMB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"custom": {"queries_off": true}}'
```

The key (`PBMB_API_KEY`) is a curator's [service account key](/docs/make-it-yours/building-on-the-api/). The same body can carry `description` too.

A write is refused when it names a key the conventions do not declare, or a value of the wrong type, and the message says which. A required field left empty does not block the write, because changing the conventions must not make every existing element unwritable. The check `metric_fields` (or `term_fields`) fails instead, and the agent fills it in.

## Read and filter

A custom field appears in every answer as `custom` on the element. `pbmb docs show dataset <id>` prints a dataset's fields.

Filter by one:

```bash
pbmb metrics list --custom owner_team=finance
pbmb terms list --custom owner_team=marketing
pbmb search net sales --kind metric --custom source_system=erp
```

The MCP tools take a `custom` object (`{"owner_team": "finance"}`; a search takes up to 16 keys), and `get_conventions` lists the fields. A filter matches the value as text.

## Use a field in a policy

A dataset's custom fields reach Cerbos as `R.attr.custom`. The default dataset policy already reads one: a dataset whose `queries_off` is `true` cannot be queried, though people can still see and search its metadata. Declare the field and set it:

```bash
pbmb conventions set element_fields.custom '[{"key":"queries_off","label":"Queries off","type":"boolean"}]'
```

Then the `curl` above turns queries off for one dataset. Your own rules can read other fields the same way ([Roles and policies](/docs/make-it-yours/roles-and-policies/)).

`custom.queries_off` leaves metadata visible and searchable. To hide a dataset from every surface and refuse queries for everyone, use [datasets on or off](/docs/set-up/what-to-sync/#turn-datasets-on-or-off). That switch is enforced regardless of custom policies.

## Custom variant axes

A variant is its metric's calculation shifted on `period`, `comparison` and `currency`. A custom axis lets your variants also differ on something else, such as `market_scope`. The rule that a variant is the same calculation, shifted, still holds. You say on which axes. Each axis lists its allowed values, and a variant move that names another value is refused with the list.

## Taking a field away

Removing a field from the conventions does not delete the values. A metric that still holds a value for a key the conventions no longer declare fails `metric_fields` with a message naming the key. Take a field away only after you have decided what to do with its values.

## Check

```bash
pbmb conventions show
pbmb metrics update total_net_sales_excl_vat --custom owner_team=finance
pbmb metrics list --custom owner_team=finance
```

`conventions show` prints a sentence per field: `Metrics have the custom field owner_team (Owner team), text; optional.` The `list` answers the metric you updated. A wrong value, such as `source_system=sap` for the choice above, is refused with the allowed values.
