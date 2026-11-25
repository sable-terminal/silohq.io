# Silo storage disclosures: for legal review

For Silo's legal counsel. The specification (70.6) makes the storage disclosure binding and says
its final copy needs legal review before the first Silo is enabled for a customer. This pack
holds every disclosure the product shows today, word for word. For each it gives when it is shown
and what the specification requires it to state, then the questions we need answered. Square
brackets mark what the product fills in from the customer's own configuration.

Prepared 23 November 2026.

## Background in brief

A customer's data normally stays in its own systems: Silo reads it when asked and keeps no
values. "Siloes" are an opt-in exception. An organisation may choose to keep data in Silo:

- **Capture:** the history of changes to chosen fields.
- **Import:** files the customer uploads, and the rows read from them.
- **Object Index:** a searchable copy of chosen fields.
- **Warehouse:** a BigQuery data warehouse kept in sync with the customer's systems.

Each Silo has a stated purpose and a retention period. The customer can delete it at any time,
with a receipt. The disclosure is what the customer reads before any of this happens. The
specification expects it to be "the most likely question from a regulated buyer".

## The disclosures

### 1. Switching Siloes on (shown once, when an administrator enables the feature)

> Switching Siloes on lets this organisation keep copies of data from its systems in Silo, but
> only in Siloes you create, each for a stated purpose and retention window, over object types and
> properties you choose one at a time. Nothing is kept until you do. Everything kept can be
> deleted at any time. Deleted data leaves Silo's backups as they expire, within 12 months, and is
> never brought back into service.

### 2. Each Silo (shown when it is created, and again when a type or field is added or retention changes)

Every one ends with the backup sentence from disclosure 1.

**Capture**

> Silo will keep the previous and new values of [fields] on [object types] each time they change,
> in Postgres, [location], for [N days]. Nothing else from your systems is kept. Nothing is kept
> the first time an object is seen: changes are kept from the second sighting. You can delete it
> at any time.

**Import, tabular files only**

> Silo will keep the files you import and the rows read from them, in Google Cloud Storage and
> BigQuery, [location], for [N days]. No model reads these files. You can delete them at any time.

**Import, where documents are read by a model**

> Silo will keep the files you import and the rows read from them, in Google Cloud Storage and
> BigQuery, [location], for [N days]. No model reads tabular files. The text of documents you
> import is sent to a language model to read it, through a zero-retention endpoint, and is never
> logged. You can delete them at any time.

**Object Index**

> Silo will keep a searchable copy of [fields] on [object types], refreshed on the schedule
> [schedule] from your systems, in BigQuery, [location], for [N days]. You can delete it at any
> time.

**Warehouse** (commercial cells only; not offered in the UK sovereign cell)

> Silo will create a data warehouse for you in Google BigQuery, in a project used only by your
> organisation, in [location], and keep the current state and change history of [fields] on
> [object types] in it, updated from your systems, for [N days]. It is encrypted with a key used
> only for your organisation. You can take it with you or delete it at any time.

### 3. Documents read by a model (a separate acknowledgement, 70.7)

Shown the first time a definition that reads documents (not tables) is published for a Silo.
Without the acknowledgement, document reading cannot be switched on for that Silo. The product
records who acknowledged it and when.

> The text of documents you import into this Silo (PDFs, text and images, read with a definition
> that has labelled or prose fields) is sent to a language model to read it, through a
> zero-retention endpoint, and is never logged. Tabular files (CSV and TSV) are never sent to a
> model. Asset models and site plans are never sent to a model.

### 4. The Action ledger (shown before the ledger is switched on)

When an organisation's systems are changed through Silo, each change has a receipt in Silo. The
ledger is an optional copy of those receipts kept in the customer's Warehouse. In a cell with no
Warehouse, it is kept in a Capture Silo instead.

In a Warehouse:

> Switching the Action ledger on keeps a copy of every executed Action in this Warehouse: one row
> per object, with the Action type, the people who proposed and approved it, the fields written
> and the outcome. With values, the copy holds the values before and after each write as well. The
> receipt in Silo remains the record; the copy carries the markings of what it describes, and is
> removed when the Warehouse is purged.

In a Capture Silo:

> Switching the Action ledger on keeps a copy of every executed Action in this Capture Silo, in
> this cell: one row per object, with the Action type, the people who proposed and approved it,
> the fields written and the outcome. With values, the copy holds the values before and after each
> write as well, encrypted. The receipt in Silo remains the record; the copy carries the markings
> of what it describes, keeps to this Silo's retention, and is removed when the Silo is purged.

## What the specification requires the disclosure to state (70.6)

- Exactly what is kept: the kind of Silo, the object types and the chosen fields.
- Where it sits: the store and its location.
- How long for: the retention period.
- Whether scheduled queries run against the customer's systems (the Object Index).
- That it can be deleted at any time.
- That backups holding deleted data expire on schedule, within 12 months at most, and that a
  restore never brings deleted data back into service (8.2). The backup sentence covers this.
- The same text is published on Silo's public security page.

## Questions for counsel

1. **Accuracy and sufficiency.** Do these texts accurately and sufficiently describe the
   processing for a UK GDPR controller's records of processing (Capture and Import are named as
   processing activities in 65.3)? Is anything missing that a customer's DPO would expect, such
   as the legal basis being theirs, or sub-processors?
2. **"You can delete it at any time."** Deletion removes data from live systems at once, with a
   receipt. Backups keep it until they expire, within 12 months. Is the backup sentence enough to
   keep "at any time" from being misleading, or should the main sentence change?
3. **Sub-processors and location.** The texts name the store (Postgres, Google Cloud Storage,
   BigQuery) and the location. Should they name Google Cloud as sub-processor, and say that a
   US-owned provider in a UK region is subject to US legal process (65.3)? The sovereign cell
   avoids such providers.
4. **The model carve-out.** Is "a language model … through a zero-retention endpoint, and is
   never logged" an adequate description? Should it name the provider (Google, Vertex AI) and the
   region, and say that the provider's terms prevent training on the data?
5. **The Action ledger "with values".** It copies before-and-after values of fields Silo wrote.
   Does that need its own lawful-basis or minimisation wording?
6. **Who acknowledges.** The disclosures are shown to the customer's administrator who enables
   the feature. The product records the document acknowledgement against a named person.
   Is acknowledgement by an administrator enough for the customer as controller, or should the
   contract require a named role?
7. **The public security page.** The same text must be published there. Does it need a version
   history, so a customer can see what was disclosed when they enabled a Silo?
8. **Legal entity.** These texts say "Silo". The terms, privacy notice and DPA still name Silo
   Data Technology Ltd and must be reissued under Silo Technologies Ltd (65.3). Should the
   disclosure name the entity?

Proposed changes can be returned as tracked wording. The texts live in the code (the Siloes
service, the Import service and the two ledger services), and each change ships with the
product, as 70.6 requires.
