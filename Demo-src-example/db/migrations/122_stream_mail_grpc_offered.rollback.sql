UPDATE connector_transports SET routes = '{}' WHERE kind IN ('imap', 'grpc', 'kafka', 'queue_tap');
