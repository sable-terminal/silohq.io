/*
 * 122 — IMAP, gRPC, Kafka and queue taps are offered.
 *
 * 120 listed them on no route because no transport served them yet, and an
 * offered protocol Silo cannot speak is a connector that fails at its first
 * read. Each now has one, so the builder and the AI may write them.
 */
UPDATE connector_transports SET routes = '{ai,visual}' WHERE kind IN ('imap', 'grpc', 'kafka', 'queue_tap');
