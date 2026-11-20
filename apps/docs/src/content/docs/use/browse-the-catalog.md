---
title: Browse the catalog
description: Read metrics and terms, then follow their measures and columns into a dataset diagram.
sidebar:
  order: 1.5
---

The catalog shows what each number means and the Power BI measures that compute it. Sign in and choose **Metrics**, **Terms** or **Datasets** in the left bar. You see the book through your own access. The screenshots below show only the invented sample tenant.

![The catalog's Metrics page, with categories and the tree beside it.](/docs/screenshots/catalog.png)

## Find your way

The left bar lists **Home**, which is the search page, then **Metrics**, **Terms** and **Datasets**. **Metrics** folds out into its categories and **Not filed**: its arrow folds them away and its name opens the Metrics home. **Datasets** folds out into its workspaces, each with its count of datasets. A dataset's arrow folds out its tables, a table's arrow its measures and columns: first the measures' display folders, which fold too and may hold folders of their own, then the measures in no folder, then the columns. Each count is what the row holds. A dataset shows its count of tables once you have opened it. A dataset's name opens its diagram. A measure's name opens its table's page on **Measures**, with the measure marked. A table, display folder or column opens its own page (see [Read a table, a folder or a column](#read-a-table-a-folder-or-a-column)). Open a category's arrow to see its children and its metrics, a page at a time with **Show more**. Choose its name to read its description, subcategories and metrics. A category's count includes its subcategories. The tree opens the path to the metric, dataset, table or field you are reading, and marks the nearest row above it that is folded. What you open or close yourself stays that way as you move between pages.

On the Metrics home, categories appear in order with their descriptions. **Not filed** holds metrics without a category. Each metric row shows its summary, unit, dataset count and trust: **Approved by a person**, **Checked by an agent** or **Draft**. Dismissed metrics are left out. A long list shows 50 metrics at a time: press **Show more** for the next 50.

A line at the top of each page below the catalog's home says where it sits, such as Metrics / Sales / Net sales. Every part but the last is a link, except Datasets, which is listed in the tree alone.

Search is on Home and in a dialog; see [Search the catalog](#search-the-catalog). On a phone, the search icon is in the top bar and the menu button beside it opens the left bar with the tree.

## Search the catalog

**Home** is the search page. Type at least two characters in its box and the results open under it as you type. Nothing typed yet? Home shows how many metrics and datasets you can see, how many are verified, and four example searches to click.

Results come in groups: **Metrics**, **Measures**, **Terms**, **Categories**, **Datasets**, **Tables** and **Columns**, each with its count. Metrics, Measures and Terms start open. Five rows show per group: choose **Show all** for up to 50. A row shows the icon, the name, where it sits, a line of its text with your words marked, and its trust. **Best match** comes first when the top hit matched on its name, alias or words. A hit found by meaning alone gets no such card. A name is found from its first letters and with one letter wrong, and a verified metric ranks a little above a draft with the same words.

**Type** narrows to one kind. **Add filter** adds **Trust**, **Workspace**, **Dataset** or **Category**, each a chip you can remove. Your words and every filter are in the address, so you can send the link. The old `/catalog/search` address lands here.

Move with the arrow keys from the box into the results, press Enter to open one and Escape to go back to the box. If your deployment has no embedding key, a line above the results says the search ran on words alone.

Everywhere else, the search button at the top of the left bar opens a search dialog, and so do `/` (outside a text field) and Cmd+K (Ctrl+K). On Home, the same keys put the cursor in Home's box. In the dialog the first row is what you typed: Enter on it opens the full results on Home. The rows below are the best hits; choose one with the arrow keys and press Enter. Escape closes it.

A **Finish setup N of M** button sits beside Home's title while setup steps are open. It disappears when every step is done. Choose it to see the steps.

## Read a metric

Choose a metric to read **Definition**, **When to use it** and **Not the same as**. Its properties show the unit, category path, owner, **Also called** and linked terms. **Not written yet** means the book has no text for that field.

Under **Variants**, compare each measure's dataset, period or other shift, and DAX. Each variant shows its DAX as it scrolls into view; its arrow folds it away. **Copy** beside the DAX copies the expression when Power BI lets you read it. **Show Order lines in the diagram** opens that dataset with the measure's table selected and in view.

When questions are on, read **Open questions** before relying on the metric. Curators and admins can also read **History**, see the checks and use **Approve**. See [For curators: approving](/docs/use/for-curators-approving/) for what approval means. Ask your agent or use the CLI to change definitions or filing.

## Read a term

Choose **Terms**, then a term. Its page shows **Dimension** or **Concept**, its trust, definition, **Not the same as**, **Also called** and **Values**. Under **Columns**, **Show in the diagram** opens the table that holds the term. Under **Metrics**, follow the numbers that use it. A concept can have no backing column.

## Read a dataset diagram

Open **Datasets** in the tree and choose a dataset under its workspace. The header names the workspace, storage mode, endorsement when present, row-level security when set, where relationships came from and when it synced. Use **Diagram**, **Documentation**, **Tables**, **Measures** or **Relationships** to change the view. Each list tab shows its count, unless relationships are unknown. **Documentation** is described under [Read a table, a folder or a column](#read-a-table-a-folder-or-a-column). **Tables** and **Measures** are the same tree as the left bar's, with each table's columns and measures counted apart and each measure's format or column's type at the end of its row: open a table to see its fields by display folder, or choose its name to open its page. **Measures** opens every table that holds a measure and leaves out the columns.

![Retail's dataset diagram, with key columns and relationship lines.](/docs/screenshots/dataset-diagram.png)

**Key columns** shows the columns at either end of a relationship. The foot of each table counts the other columns and measures. Choose **All columns** to see the rest. The key icon marks a relationship column. The crossed-out eye means Power BI hides the column. Neither icon means PII.

Read a line's ends to understand the join: a crow's foot means many, and a bar means one. A dashed line marked **inactive** is used only when a query activates it with `USERELATIONSHIP`. **both ways** means filters travel both ways. Click a line to read its exact column references, **Cardinality**, **Filters** and **State**.

Hover a line or table to highlight its relationships. Select a table to keep its neighbours highlighted and read its description, columns, measures by display folder and relationships in the panel. Choose a relationship in that panel to read it without clicking a line. You can also focus a table with the keyboard and press Enter. Click empty canvas, press Escape or use **Close panel** to clear the selection.

To find a table, type part of its name in **Find a table** above the diagram. Tables without it in their names fade. Pick a hit with the arrow keys and Enter, or click it: the diagram zooms to that table, selects it and opens its panel. Escape closes the list, and pressed again clears the box. Clearing the box after a pick keeps the diagram on that table; clearing it without a pick puts the diagram back where it was before you searched. The address names the table you select, so a link to it opens the same view.

Scroll to move through the diagram, pinch to zoom, or use its zoom controls. A tall model has a minimap at the bottom left. A model too wide to fit at the initial 60% zoom floor starts at its left edge. Selecting a table keeps it in view without fitting the whole diagram again. You can drag tables, but their positions are not saved. Changing the columns view also lays them out again.

## Read a table, a folder or a column

A table, a display folder and a column each have a page, reached by a link. Their addresses are `/catalog/datasets/<id>/tables/<table>`, `.../folders/<folder>` and `.../columns/<column>`. A line at the top says where you are: workspace, dataset, table, then the folders down to the page.

A dataset, a table and a column each show **Definition** first: the book's description, or Power BI's with **From Power BI** when the book has none. **Description in Power BI** follows when the two differ. Then come the kind's built-in fields, its custom fields, and **Details**, the facts read from Power BI. An empty field says **Not written yet**.

| Kind | Built-in fields after Definition |
|---|---|
| Dataset | When to use, Owner, Freshness, Caveats. |
| Table | Grain and filters, Caveats. |
| Column | Unit, Blank means. |

Custom fields come from `dataset_fields.custom`, `table_fields.custom` or `column_fields.custom` in the conventions. Details includes **Last documented** when the book has a documentation date. Curators write documentation through the CLI:

```bash
pbmb docs set dataset <id> --description "Sales and returns by product and day." --when-to-use "Use for sales questions. For campaign spend, use Marketing."
pbmb docs set table <id> --grain "One order line. Test orders left out."
pbmb docs set column <id> --unit money --blank-means "No price was recorded."
pbmb docs check --dataset Sales
```

`--description` (or `--file` for a text file) writes Definition on any kind, including a measure. Datasets also take `--owner`, `--freshness` and `--caveats`; tables take `--caveats`. A flag for another kind is refused with `docs.field_not_on_kind`. A `--unit` outside `column_fields.unit.values` is refused with `docs.unit_not_allowed`. `pbmb docs check` lists missing required fields. For a curator, it also lists the conventions exceptions that are no longer used. It exits 1 when it lists anything. Add `--json` for findings with rule ids.

A table page opens on **Documentation**, then has **Columns**, **Measures** and **Relationships**. It has no diagram; the dataset's page has that. **Columns** and **Measures** list every field A to Z with its display folder, format or data type, description and, for a measure, the metric that covers it. Type in the filter box to narrow the list; a long list shows its first 100 and **Show more**. **Relationships** lists the table's joins, and each column in them opens its page. A folder page lists the measures and columns of one display folder. Power BI nests folders with a backslash, so the address of `Margin` inside `Sales` ends in `folders/Sales%5CMargin`, one piece. A table, folder level or column named just `.` or `..` has no link; its name shows as text.

A column page shows the column's badges (**Hidden**, **Calculated**, **PII**) and its documentation, with its data type, format string, display folder and column type under **Details**. A calculated column also shows its DAX. Under **Terms** are the terms linked to the column. Under **Relationships** are the relationships that name it, and each opens the dataset's **Relationships** tab. Under **Measures whose DAX names this column** are the measures that read it, found by their text, with the metric each backs. Without `pii_reader`, a PII column answers as if it does not exist.

## When relationships are unknown

**Relationships unknown** means the book could not read the relationships. It does not mean the model has none. In the Diagram tab, **No lines drawn.** and the explanation appear above tables arranged in a grid.

Follow that explanation. You may need to connect Power BI in **Settings**, under **Connections**, ask the dataset's owner for the Build right, or try again in a few minutes. If Power BI refuses INFO functions on the dataset, ask its owner in Power BI. The book tries again after the model next changes. On the sample tenant, Marketing shows this state.

If you see **No tables to draw**, Power BI could not give the schema. The page explains that the next sync reads it again after the model is refreshed.

## PII in the table panel

With `pii_reader`, you can see a **PII** tag beside a protected column. Without it, the panel reports how many columns are **hidden as PII** and leaves them out. Admins can hover or focus an unmarked column to reveal **Mark PII**. See [PII in the browser](/docs/make-it-yours/pii-in-the-browser/) before changing a rule.

## Check on the sample tenant

Choose **Terms** in the left bar, then **Channel**. Choose **Show in the diagram** beside a backing column. The dataset opens with that table selected and its panel visible. Choose **Relationships** to read the same joins as rows.

## Choose an icon

Metrics, categories, terms, datasets and workspaces can carry an icon. Anyone can see it, in the left bar, in lists, in search results and above the title of the page. Only curators and admins can choose one: for them the icon above the title is a button.

The picker has two tabs. **Emoji** lists emoji by group. **Icons** lists line icons: pick a color first (gray, green, teal, blue, violet, red, amber or ink), then the icon. Each tab has a **Search** box for the emoji's name or the icon's. **Reset** puts the kind's own icon back. Escape closes the picker.

An icon is how a thing looks, not what it means: choosing one does not change a metric's trust, and the change is still recorded. Your agent can do the same with `pbmb icons`; see the [CLI reference](/docs/reference/cli/#pbmb-icons).
