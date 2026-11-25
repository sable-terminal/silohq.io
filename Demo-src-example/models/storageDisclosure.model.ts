/**
 * §11 — what switching storage on means, in the words shown before it can be.
 *
 * ── ONE TEXT, IN TWO PLACES ─────────────────────────────────────────────────
 *
 * The product shows these paragraphs before a super admin can switch storage on,
 * and the public security page shows the same paragraphs. "Writing it now rather
 * than afterwards is what keeps the product and the public claim consistent" —
 * so a standing test fails the build when this file and
 * `website/client/src/lib/storageDisclosure.json` differ by a character.
 *
 * ── EVERY SENTENCE IS A CLAIM THE CODE HAS TO KEEP ─────────────────────────
 *
 * "Never longer than 730 days" is `siloes_retention_days_check`. "Past its window
 * it can no longer be read" is the window filter on every read in `silo.repo`.
 * "Never sent to an AI model, written to logs or copied into the audit trail" is
 * `siloValueEgress.test.ts`. Change a sentence and the thing that makes it true
 * has to change with it.
 */
export const STORAGE_DISCLOSURE: readonly string[] = [
  "Silo keeps nothing from your systems unless your organisation switches on storage and creates a Silo, with one exception: a change to your systems made through Silo, described at the end. Until then every answer is read from your systems and discarded, and nothing else described here exists.",
  "A Silo can capture changes. For each concept it is told to watch, and only for the fields nominated on it, Silo keeps which record changed, which field, the value before, the value after, when the change was seen, and which of your systems it came from. So that it can recognise a change, it also keeps the last value it saw for each of those fields. Nothing else from the record is kept. Capture happens only as people ask questions: a record nobody asks about is never captured, and capture fetches nothing from your systems for the sake of storing it.",
  "A Silo can also hold files your organisation imports. The files themselves are kept, together with the records read out of them under a structure your organisation defines and tests against those files. Spreadsheets and CSV files are read column by column, and PDF documents by finding labelled fields and table columns on the page, and neither involves an AI model. Every value read from a document is marked as read from a document, with the page it came from.",
  "A Silo can also keep a whole concept. For each concept your organisation chooses, and for no other, Silo copies the records every one of your systems holds of it into the Silo, about once a day, so that questions about it can be answered from the copy where there are too many records to read live. This is the one case in which records are fetched from your systems in order to be stored, and it happens only for a concept somebody with the right to manage the Silo has asked to be kept. A copy holds the fields that person may see and no others. Each copy replaces the one before it, unless that person has also asked for the concept's past copies to be kept: then each day's copy is kept beside the last, so that Silo can be asked what the concept held on a date and what has changed since one, and each is deleted once it is older than the Silo's retention window. Past copies are never kept unless they are asked for, and asking for them to stop deletes them at once. Where more than one of your systems holds a kept concept, Silo also works out from those copies, and keeps beside them in the Silo, which record in each system is the same thing, which field in each system is which, and the pairs of values the systems give for the same field of the same record, so that a question about a few records can draw on what all of them showed. These are remade at every copy and deleted with the copies. A super admin can let a named Google account, group or service account outside Silo read what one Silo keeps, so that a reporting tool can use it. That reader is given a set of views of the latest copy of each kept concept, of its past copies where they are kept, and of what Silo worked out from them, and is given nothing else. A reader of those views is not asking through Silo: they see every field of every record the copies hold, whatever is hidden from whom inside Silo. Nobody outside Silo can read a Silo unless a super admin has named them, taking them off the list takes the access away, and every name added or removed is recorded in the audit trail. An answer read from a copy says so, and says when the copy was made, and is written up in the same way as an answer read live, as your organisation's setting for written-up answers allows. When a concept stops being kept its copies are deleted, and its questions are read from your systems again.",
  "What a Silo keeps is stored in Silo's own infrastructure, in the same region as the rest of your organisation's account, and separated from every other organisation. It is never written to logs or copied into the audit trail, and it is never sent to an AI model except in the one case described next.",
  "Your organisation can separately choose to have documents read by an AI model, for contracts, reports and correspondence that have no labels to find. Nothing is sent to a model until a super admin makes that choice, having read what it means, and then only the text of documents your organisation imported into a Silo under a structure that asks for them to be read that way. Every value read like this is marked as inferred, with the model's own score and the passage it came from. Importing spreadsheets, CSV files and PDFs read by label or column never sends anything to a model.",
  "Each Silo has its own retention window, chosen when it is created and never longer than 730 days. A change is deleted once it is older than the window, a last-seen value once it has not been seen for that long, an imported file, with everything read out of it, once it was received longer ago than that, and a copy of a kept concept once it was made longer ago than that. Past its window it can no longer be read, even before it is deleted.",
  "Anything in a Silo can be deleted at any time: the changes to one record, one imported file with everything read out of it, one concept, or the whole Silo. Each deletion produces a receipt saying what was removed, and your organisation can require a second person to approve it.",
  "Switching storage off stops capture and import immediately. What is already held stays until its window passes or it is deleted.",
  "Changing your systems through Silo does not depend on storage being switched on, and switching storage off does not stop it. Before a change is shown to anybody, Silo reads the records it would alter and keeps, for each one, its identifier and the current value of each of the concept's fields the change would alter or remove, together with the new values proposed. Nothing else from the record is kept. None of it is written to logs, sent to an AI model or copied into the audit trail, which records which fields and how many records a change reaches rather than any value. A change nobody carries out lapses 24 hours after it was prepared and is then deleted with everything it read, and is never kept longer than 30 days. A change that is carried out is kept, together with what each record held afterwards and who approved it, as a receipt for as long as your organisation chooses, a year unless it chooses otherwise, so that it can be reviewed and undone; nothing kept for a change is kept longer than 730 days. Past that it can no longer be read or reverted, even before it is deleted with everything it read. A receipt can be deleted sooner, with everything kept for its change, and your organisation can require a second person to approve that.",
];

/**
 * Import §8 — the carve-out, in the words a super admin reads before choosing it.
 *
 * "This is a genuine exception to the rule that no business data is sent to a
 * model, and it is stated at enable time rather than discovered in a security
 * review." Its own text and its own version: acknowledging storage is not
 * acknowledging this, and a change to either text asks again for that one.
 */
export const DOCUMENT_MODEL_DISCLOSURE: readonly string[] = [
  "Reading documents with a model sends a document's text to Google's Vertex AI, the model Silo already uses to plan questions. It is an exception to Silo's rule that none of your business data goes to a model, so it is a separate choice from switching storage on, and from having answers written up by a model.",
  "Only documents your organisation has imported into a Silo, under a structure that asks for them to be read this way, are sent. Spreadsheets, CSV files and PDFs read by label or column are never sent.",
  "The model is used under zero data retention: Google does not keep the text after answering, and this deployment sends no document until that has been confirmed for it. The text is never written to Silo's logs or audit trail.",
  "Every value read by the model is marked as inferred. Its flag shows the model's own score, described as a model score rather than a measured figure, and the passage of the document the value was read from. A value the model cannot point to in the document is refused rather than stored.",
  "A person can confirm a value the model read, after which it is treated as certain. Switching this off stops any further document being sent; values already read stay, marked as inferred, until they are confirmed or deleted.",
];

/**
 * 129 — answers written up by a model, in the words shown on the organisation's
 * settings beside the switch that turns it off.
 *
 * THE SECOND EXCEPTION, AND SAID AS ONE, even though it is on by default. Until this, the model saw the names of
 * things and never a value; an answer described in depth needs it to read what
 * the answer read. Every sentence is a claim the code keeps: the rows sent are
 * `READING_ROWS`, the figure check is `figures.render`, the chart is drawn by
 * the client from the records, and the web search is sent the questions alone
 * (`compile.service`).
 */
export const ANSWER_MODEL_DISCLOSURE: readonly string[] = [
  "Silo writes answers up with Google's Vertex AI, the model it already uses to plan questions: the model is sent what an answer read from your systems, so that it can describe what was found in its own words, choose a chart that fits, and answer follow-up questions about it. It is an exception to Silo's rule that none of your business data goes to a model. It is on for every organisation unless a super admin switches it off, and it is separate from reading documents with a model, which stays off until chosen.",
  "Only what the question read is sent, and only for the person who asked it: a summary of each field across every record the question matched, and the first 60 of those records, limited to the fields that person is allowed to see.",
  "The model is used under zero data retention: Google does not keep what it is sent after answering, and this deployment sends nothing until that has been confirmed for it. None of it is written to Silo's logs or audit trail, and the written answer is not kept once the conversation is closed.",
  "Every figure in a written answer is checked against the figures Silo read, and one that is not among them is marked as worked out by the model rather than read from your systems. Charts are drawn by Silo from the records themselves; the model only chooses which chart to draw.",
  "Context from the web is never mixed in silently, and it only adds to what your systems hold, never answers in their place. It is looked for unless the person asking switches it off. The search is sent the names of organisations an answer read, with their websites where your records hold them, so that it can fill what your records lack, and, for a question about nothing your systems hold, the question itself. It is never sent a person's name or contact details, a figure, or an identifier, and it keeps nothing. Every sentence that uses what it found carries a numbered link to where it came from.",
  "A super admin can switch this off for the whole organisation at any time, which stops anything further being sent. Answers are then described in fixed sentences made from their figures alone.",
];
