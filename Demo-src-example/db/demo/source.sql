-- A stand-in for a customer's own database.
--
-- NOT A SILO TABLE AND NOT MIGRATED. The engine reads this THROUGH a connector,
-- exactly as it would read a customer's warehouse — which is the whole point:
-- a mocked transport tests the mock, and the claim being made is that one
-- engine plus one document reaches a real system.
--
-- The reader role is read-only on purpose. §7 keeps writes disabled until a
-- sandboxed cycle passes, and a source that CANNOT be written to is a stronger
-- statement than one we have decided not to write to.
--
-- Run with:  npm run demo:source

SELECT 'creating silo_source_demo' AS step \gexec
CREATE DATABASE silo_source_demo \gexec

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'silo_demo_reader') THEN
    CREATE ROLE silo_demo_reader LOGIN PASSWORD 'demo_reader';
  END IF;
END $$;

\connect silo_source_demo

DROP TABLE IF EXISTS scratch;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
  id          integer PRIMARY KEY,
  name        text    NOT NULL,
  country     text    NOT NULL,
  created_on  date    NOT NULL
);

CREATE TABLE invoices (
  id          integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  reference   text    NOT NULL,
  total_pence integer NOT NULL,
  status      text    NOT NULL,
  issued_on   date    NOT NULL
);

INSERT INTO customers VALUES
  (1, 'Northwind Traders', 'GB', '2023-04-11'),
  (2, 'Contoso Ltd',       'GB', '2024-01-05'),
  (3, 'Fabrikam GmbH',     'DE', '2024-07-22'),
  (4, 'Tailspin Toys',     'US', '2025-02-14');

INSERT INTO invoices VALUES
  (1, 1, 'INV-1001', 125000, 'paid',    '2025-01-10'),
  (2, 1, 'INV-1002',  48000, 'overdue', '2025-03-02'),
  (3, 2, 'INV-1003', 960000, 'paid',    '2025-04-18'),
  (4, 3, 'INV-1004',  12500, 'draft',   '2025-06-01'),
  (5, 3, 'INV-1005', 300000, 'overdue', '2025-07-09'),
  (6, 4, 'INV-1006',  75500, 'paid',    '2025-08-21');

GRANT CONNECT ON DATABASE silo_source_demo TO silo_demo_reader;
GRANT USAGE ON SCHEMA public TO silo_demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO silo_demo_reader;

/*
 * A SANDBOX TABLE, AND A ROLE THAT CAN ONLY TOUCH IT.
 *
 * §7.4 keeps writes disabled until a write, verify and undo cycle passes
 * against a TEST RECORD, and that cycle cannot be exercised against a source
 * nothing may write to. So the customer-shaped tables above stay unwritable —
 * which is the stronger statement and the reason they exist — and this is the
 * scratch space the cycle runs in.
 *
 * The writer holds nothing on `customers` or `invoices`. A verification that
 * could touch the real tables would be testing the wrong thing and risking the
 * data it was supposed to be careful with.
 */
CREATE TABLE scratch (
  id      integer PRIMARY KEY,
  label   text    NOT NULL,
  amount  integer NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'silo_demo_writer') THEN
    CREATE ROLE silo_demo_writer LOGIN PASSWORD 'demo_writer';
  END IF;
END $$;

GRANT CONNECT ON DATABASE silo_source_demo TO silo_demo_writer;
GRANT USAGE ON SCHEMA public TO silo_demo_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON scratch TO silo_demo_writer;
