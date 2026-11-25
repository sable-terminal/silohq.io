/**
 * A document's text, where it sits on the page.
 *
 * Import §3 — "structured document: locate labelled fields". What is located is
 * text at a position, so the position is kept with the text from the moment a
 * PDF is read until a value is stored, and the value's flag can say where on
 * which page it was read.
 *
 * PDF COORDINATES: the origin is the bottom-left corner of the page, so a larger
 * `y` is higher up.
 */

export interface DocumentTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentPage {
  /** 1-based, as a person counts pages. */
  page: number;
  items: DocumentTextItem[];
}

/** Where a passage sits in a document's text: for a document with no pages. */
export interface TextSpan {
  offset: number;
  length: number;
}

/** Where a value was read: the page, and the box around the text it came from. */
export interface ValueLocation {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
