INSERT INTO hmac_canonicalisations (name, description) VALUES
  ('aws_sigv4',      'AWS Signature Version 4'),
  ('shopify',        'Shopify HMAC over the raw body'),
  ('stripe_webhook', 'Stripe signature with a timestamped payload'),
  ('twilio',         'Twilio X-Twilio-Signature over the sorted parameters')
ON CONFLICT (name) DO NOTHING;
