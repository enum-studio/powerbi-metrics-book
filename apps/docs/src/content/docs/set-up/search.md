---
title: Search
description: Choose OpenAI, Gemini or no embedding provider, enter its key, and see what the book would cost to embed.
sidebar:
  order: 7
---

Search is set in the admin section, not during the first run. Search by meaning embeds each metric's text with OpenAI or Gemini, so an agent can find a metric from a question. Without it, agents find metrics by name and by filters, and every answer says so. Keep **None** to use names and filters, or turn search on in the admin section.

## Before you start

- An account with OpenAI or Google, and permission to create an API key there.


## What is sent, and what is not

Only metadata leaves the stack, and only to the provider you choose.

| Sent to the provider | Never sent |
|---|---|
| Names, keys, definitions, aliases, descriptions, display folders and category paths of metrics, variants, columns and terms. The names of the dataset and workspace a variant sits in. The words of a search, so they can be compared by meaning. One fixed sentence, "Net sales by month, in euros, for last year.", when the check runs. | DAX, query results, rows of data, and the text of questions and comments. |

Datasets, tables, categories, questions and the query log are searched by words only and are never embedded.

## Steps

1. In the admin section, under **Search**, choose a **Provider**: **None**, **OpenAI** or **Gemini**. With **None**, press **Check search**.
2. Create an API key with the provider:
   - **OpenAI**: create an API key in the OpenAI dashboard.
   - **Gemini**: create a key in Google AI Studio. Gemini rejects unrestricted standard keys, so use a key made in AI Studio now (they are authorization keys by default) or one with explicit restrictions.
3. Paste it into **OpenAI API key** or **Gemini API key**, whichever the admin section shows for your provider. It is saved encrypted for the api and the worker, and nothing can show it again.
4. Leave **Model** empty to use the default, or enter a model as the provider names it:

   | Provider | Default model | Price per million tokens |
   |---|---|---|
   | OpenAI | `text-embedding-3-large` | $0.13 |
   | Gemini | `gemini-embedding-2` | $0.20 |

   Prices were read on 25 October 2026. Vectors are 1536 numbers long for both. Changing the provider or the model re-embeds everything on the next sync.
5. Press **Check search**.

Source for step 2: [OpenAI quickstart](https://platform.openai.com/docs/quickstart) and [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key).

## Check

The check embeds the one fixed sentence, then counts the book's search documents. It passes with a sentence such as:

```text
One sentence was embedded with openai text-embedding-3-large. Embedding the book as it stands, 0 documents, would cost about $0.0000.
```

The cost is an estimate of about 4 characters to a token, so it runs a little high or low. A count of 0 means no search documents have been synced yet. For scale: 5,000 search documents of 150 tokens each are 750,000 tokens, about $0.10 with OpenAI. Press the button again after [First sync](/docs/set-up/first-sync/) for the real figure. Later syncs embed only text that changed.

Run it later with:

```bash
pbmb admin check search
```

With **None** it passes with "Search is off: agents find metrics by name and by filters." If a sentence appears, find it on [When a check fails](/docs/set-up/when-a-check-fails/#search).

Next: [Agents](/docs/set-up/agents/).
