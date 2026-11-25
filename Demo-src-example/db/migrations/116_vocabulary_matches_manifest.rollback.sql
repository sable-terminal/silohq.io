UPDATE pagination_strategies SET strategy = 'opaque_cursor'     WHERE strategy = 'cursor';
UPDATE pagination_strategies SET strategy = 'body_continuation' WHERE strategy = 'body_token';
UPDATE pagination_strategies SET strategy = 'scroll_keepalive'  WHERE strategy = 'scroll';

UPDATE response_envelopes SET envelope = 'plain_array' WHERE envelope = 'array';
UPDATE response_envelopes SET envelope = 'json_api'    WHERE envelope = 'jsonapi';

INSERT INTO response_envelopes (envelope, description)
  VALUES ('nested', 'Nested, requiring flattening')
  ON CONFLICT (envelope) DO NOTHING;
