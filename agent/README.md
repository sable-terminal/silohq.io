# Silo Agent

The Silo Agent (spec chapter 10) is one static binary that the customer runs inside their own network. It connects outbound only, to `agent.<cell>` on TCP 443 over TLS 1.3 with its own client certificate. It holds one HTTP/2 tunnel that carries work from the cell, and listens on nothing but a loopback health endpoint.

It is written in Go, decided on 2026-11-16 (this settles spec 10.1's open decision).

## Build

```
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.Version=1.2.3 -X main.ReleaseKeys=<keys>" -o silo-agent ./cmd/silo-agent
GOOS=linux GOARCH=arm64 ...    GOOS=windows GOARCH=amd64 ...
```

`ReleaseKeys` are the Silo release public keys the agent trusts for its own updates: base64 SubjectPublicKeyInfo DER, comma separated (more than one while a key is rotated). A build without them takes no update.

The binary is about 11 MB and has no runtime dependencies. Release builds are reproducible and signed through Fleet. The build puts each platform's binary into fleet-control's artefact store (`npm run fleet:agent-binary -- <binary>` in `app/server`, which prints the digest the release manifest names) before the release is registered.

## Run

1. In Silo, someone with `agent.enrol` creates a pool and issues an enrolment token (single use, valid for 24 hours).
2. Write the configuration file. Make it readable by the agent's user alone (`chmod 600`), because it may hold logins:

   ```json
   {
     "endpoint": "agent.uk-lon-1.silohq.io:443",
     "stateDir": "/var/lib/silo-agent",
     "name": "plant-a",
     "proxy": "http://proxy.corp:3128",
     "targets": ["db.corp.example", "*.plant.corp.example", "10.20.0.0/16"],
     "fileRoots": ["/mnt/exports"],
     "connections": {
       "<connection id>": { "dsnFile": "/etc/silo-agent/erp.dsn", "replicationDsnFile": "/etc/silo-agent/erp-replication.dsn" }
     }
   }
   ```

   Logins (spec 10.7) are the cell's by default: a connection's login is kept sealed in Silo, and passed to the agent for one call at a time. The connection names its database's address (its parameters `host`, `port`, `database`, `sslmode`), and `targets` lists the systems the cell may send this agent to: host names, `*.` wildcards, addresses and networks. With no targets, the agent takes no login from the cell. A host name outside the named ones must resolve wholly inside the listed networks, and is reached at those addresses only.

   A connection created with its login kept on the agent's host (custody `agent`) names it here instead, under `connections`: `dsn` or `dsnFile`, a URL of its database's kind: `postgres://user:password@host:5432/database?sslmode=...`, `mysql://user:password@host:3306/database?sslmode=...` (`disable`, `prefer`, `require` or `verify-full`, as for Postgres), `sqlserver://user:password@host:1433?database=...&encrypt=true` or `oracle://user:password@host:1521/service`. The cell then holds none.

   An SFTP connection read through the agent reaches only a server within `targets`, and only one presenting the host key the connection pins (its `host_key_sha256`); its login, a password or a private key, is the cell's, sealed to this agent for each read.

   `fileRoots` lists the directories a file share may be read beneath (spec 14.4): absolute paths on this host, such as where a network share is mounted. A file share connection's manifest names its root as `file:///…`; the agent lists a directory's regular files and reads a file in chunks only where the path, every link resolved, lies within one of these roots, and with none listed it reads no file. It never writes, and the host's own permissions still apply.

   `replicationDsn` or `replicationDsnFile` is the read-only replication login used for change data capture, where the connection streams by it. A capture reader runs on, through tunnel drops, beyond any one call, so its login is always held here.

   Optional settings:
   - `spoolMaxMb` (default 10240), `spoolMaxDays` (default 7) and `airGapped` (default spool age 30 days): the store-and-forward spool's bounds;
   - `serverName` and `endpointCaFile`: pin the endpoint's name and certificate authority;
   - `healthListen`: must be a loopback address (default `127.0.0.1:9440`);
   - `discoveryDisabled`: discovery off on this host, whatever the cell authorises;
   - `discoveryPorts`: the ports a discovery port scan tries, in place of the usual ones (databases, file transfer, message brokers, HTTP);
   - `discoveryConfigPaths`: further files, absolute paths, that discovery's host configuration may read for the systems they name;
   - `maxConcurrentCalls`: default 32, at most 256;
   - `memoryLimitMb`: default 512, at most 4096.

3. Enrol once: `silo-agent enrol -config agent.json -token silo_enr_...`. The agent makes its P-256 key, which never leaves the host, and sends a signing request. It keeps the 30-day certificate the cell issues. It also makes an X25519 key for logins sealed to it (`stateDir/sealing.key`), and sends its public half.
4. Run under a service manager: `silo-agent run -config agent.json`. The installed binary is a launcher: it runs the agent as a child process, the update it last took if that is later than itself and intact, and restarts it onto the next. If the launcher goes, the child stops too.

## What it does today

- **Tunnel:**
  - heartbeats every 10 seconds;
  - work answered on one stream per piece of work;
  - reconnects with backoff;
  - works through an HTTP CONNECT proxy;
  - names the issuer when a TLS-inspecting proxy breaks mutual TLS;
  - stops when the cell revokes it.
- **Reads:** Postgres, MySQL (MariaDB too), SQL Server and Oracle, in the dialect the cell generates for each, all in pure Go (no database client to install). In Postgres, MySQL and Oracle each statement runs in a read-only transaction the server enforces, so a read cannot write. SQL Server has none: there, as in Oracle, a read must be one SELECT (anything else is refused before it runs) and its transaction is always rolled back; give the login only `db_datareader` (and `db_datawriter` only where Silo's writes are granted). Rows go back in frames up to the bound, with values as the cell reads them: numerics as their digits, moments in UTC to the millisecond, dates as dates, binary as hex. A failure is reported as the source's SQLSTATE, never its message.
  - Error numbers come back as the SQLSTATEs they stand for (SQL Server's 208 and Oracle's ORA-00942 as 42S02, a refused login as 28000), so the cell classifies them as it does Postgres's.
  - Oracle: the login's database is the service name, and the login is an ordinary Oracle user (Oracle's clients log on without regard to the name's case). NUMBER whole numbers are numbers and decimals keep their digits; DATE and TIMESTAMP (no zone) are their wall clock in UTC, so a DATE holding a date reads as that date.
  - MySQL runs on the binary protocol with prepared statements (go-mysql). Each session runs in UTC, so a `TIMESTAMP` reads as the moment it is, and counts the rows a statement matched, not only those it changed, so a granted update setting a value already there still counts its row.
- **Logins (spec 10.7):**
  - **Cell-held (the default).** The cell's credential service opens the connection's login for one piece of work and seals it to this agent's X25519 key with HPKE (RFC 9180: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, Go's `crypto/hpke`). The seal is bound to the organisation, this agent, the connection and the work's id, and valid for two minutes.
    - The agent opens it only for that work and only before it expires.
    - It connects only to a target the configuration allows (`login_refused`, with the reason, otherwise).
    - It uses one connection for the call, then closes it and wipes the password.
    - The password is unescaped straight into pages outside Go's heap, which the garbage collector never moves or copies. They are locked into memory so they are never swapped to disk, and kept out of core dumps. The copies made while decrypting and parsing are wiped at once. The driver's own working copies during authentication are not under the agent's control.
    - Where the host's memory-lock limit is too low (containers often allow 64 KB), the password is still held off the heap and wiped, and the agent warns once at start (`agent.logins_unlocked`; raise `LimitMEMLOCK` or `--ulimit memlock`). memguard's own memory layer (memcall) is used rather than its buffers, which crash the whole process on a lock they cannot take.
    - A new sealing key comes with each certificate renewal, and the one before is kept for work sealed before the cell heard.
  - **Agent-held.** The login stays in this file, with a small pool per connection, and the cell records each use as `held_by_agent`.
- **Change data capture:** Postgres logical replication (spec 10.4) from a publication the customer made, with their replication login. The cell leases a slot to one agent of the pool, and the agent makes the slot on first read. It sends each committed transaction up its own stream: a large one in parts, each change with its place in the log. Postgres hears only positions the cell acknowledged, so a failure replays from there and nothing is lost. A quiet publication holds no log back.
- **MySQL change data capture:** the binary log of a MySQL 8.0+ server, read as a replica does. The replica registers under the slot name the owner confirmed, so it shows in `SHOW REPLICAS`. The replication login needs `REPLICATION SLAVE` and `REPLICATION CLIENT`. The server must run with `binlog_format=ROW`, `binlog_row_image=FULL` and `binlog_row_metadata=FULL`; otherwise the reader refuses and logs which setting is wrong. The binary log carries every table on the server, but the agent reads only the tables the cell names (those the manifest streams by capture), and nothing else leaves the host. The server keeps no slot for the agent, so a binary log purged before it was read loses the capture.
- **SQL Server change data capture:** change tracking, polled once a second in a snapshot transaction. The database must track changes (`ALTER DATABASE ... SET CHANGE_TRACKING = ON`) and allow snapshot isolation (`ALLOW_SNAPSHOT_ISOLATION ON`), and each captured table must track changes (`ALTER TABLE ... ENABLE CHANGE_TRACKING`). The login needs `SELECT` and `VIEW CHANGE TRACKING` on the captured tables, and the agent reads only the tables the cell names. Change tracking keeps each row's latest change since the last read, not every step in between, and it records no commit time: a change's time is when the agent read it. If SQL Server cleans up tracking past the last acknowledged version, the capture is lost.
  - A slot that is gone or invalidated is reported lost, never made again.
  - The cell can have the agent drop the slot.
  - At most 16 readers. A capture the agent cannot read (no replication login, no room) is refused, so the cell offers it to another agent.
  - Set `max_slot_wal_keep_size` on the source, so that a slot nobody reads cannot fill its disk.
- **Store-and-forward (spec 10.6):** every change goes into a spool under `stateDir/spool` and up from there, in log order, so the reader carries on while the tunnel is down or the cell is slow.
  - Encryption: each record is sealed with AES-256-GCM under a key derived from a host key (`spool/host.key`, 0600) and a random salt in each segment. Positions, counts and times are readable and authenticated; values are not readable.
  - Bounds: at the size bound the reader waits, because the source still holds what is unread. Only when the slot is about to be invalidated does the oldest spooled data go, so the slot survives.
  - What goes is reported to the cell as a gap record: counts and a time range, no values. So is a record that will not open.
  - The cell receipts every record, a part of a large transaction included.
  - The heartbeat names the slots the agent reads and the spools holding what only they have, so the cell gives those slots back to it on reconnecting.
  - The spool's size and gaps are logged once a minute.
- **Certificate renewal:** with a new key when less than 10 days are left (at 20 of 30).
- **Writes (spec 10.4):** a write runs only on an execution grant the cell's actions signed (Ed25519) for exactly its statements. The agent checks the grant itself, with the key the cell gave it at enrolment or renewal (`stateDir/grant.pem`):
  - the signature over the grant's exact text, and the signing key's id;
  - the expiry, the organisation and the connection;
  - the statement count, and the SHA-256 of the statements as they arrived.

  A grant runs once. A granted write runs in one transaction, and a statement that changes other than its expected rows rolls it all back. Anything else is refused with its reason, nothing runs, and the cell audits it.
- **Discovery (spec 10.5, chapter 19):** a scan runs only on a scan the cell's discovery service signed (Ed25519) for one run of an authorisation people approved, naming this agent. The agent checks it with the key the cell gave it at enrolment or renewal (`stateDir/discovery.pem`): the signature over the scan's exact text, the organisation and agent, the start-by time, and the SHA-256 of the authorisation document it carries. A scan runs once. Targets, methods, the host bound and the expiry come from that document alone; there is no default subnet, and nothing is inferred from the agent's own address. `discoveryDisabled` refuses every scan. What it does:
  - **host configuration:** ODBC data sources (`odbc.ini` files, and the registry on Windows), network mounts, cron files and `discoveryConfigPaths`. From each it takes only which system it names, where, and what it appears to be, never a user, password, database name, path or command, and reports only systems within the targets;
  - **catalogue introspection:** of the connections this agent holds a login for, where the host is a target. It runs a fixed list of Postgres catalogue statements in a read-only transaction: schemas, tables, columns and types, keys, and the planner's row estimates. It never reads a row;
  - **port scan:** the targets' hosts, at most 50 new hosts a second and 2 connections per host, within the host bound. It recognises what answers without logging in or asking for data: a banner, Postgres's SSL request, SQL Server's pre-login, or an HTTP HEAD;
  - OPC UA and MQTT are reported as unavailable for now.

  Every probe is reported, and the scan stops at its authorisation's expiry or when the cell stops it. The sovereign build (`go build -tags sovereign`) leaves discovery out entirely.
- **Updates through Fleet (spec 10.7, 11.4):** the agent asks the cell hourly (the first time 1 to 5 minutes after starting) whether to update. The cell answers from the releases Fleet promoted to agent-stable, the pool's update policy (the cell's waves, a pinned version, or a version someone approved) and one agent of a pool at a time. The agent trusts the cell for none of it. It takes an update only when:
  - the channel head and the release manifest each carry a valid signature by a release key built into it (`ReleaseKeys`), over the exact text it received;
  - the head is on agent-stable and names this manifest, so a release that was registered but never promoted is refused;
  - the release is for this build target and names a binary for this platform, with the version and digest offered;
  - the version is later than its own and has not failed on this host before;
  - the downloaded bytes, fetched over its mutual TLS connection, hash to the digest.

  The binary goes into `stateDir/bin` (0700), beside the one it ran before, and the agent stops, finishing the work in hand for up to a minute, for its launcher to start the new one.
  - **A failed update:** an update that exits with a failure within two minutes of starting is undone. The launcher goes back to the binary before and remembers that version as failed, and the agent tells the cell (`agent_update_refused`, `failed_to_start`).
  - **Going back on the cell's word:** when a wave fails its gates, the cell tells the agents it updated to go back. An agent goes back only to the binary it kept, never to a download.
  - **Refusals:** a refusal is reported with its reason, and kept to send again if the cell cannot be reached.

  The sovereign build takes no update through the tunnel. Its releases reach the sovereign cell as bundles that cleared staff countersign, and are installed from there.
- **Logs:** JSON lines with counts, durations and outcomes only. They never contain statements, values or rows. Crash dumps are off: no tracebacks with memory, and no core files where the host allows it.

## Still to come

- other databases (SQL Server, Oracle, MySQL), each with the user's approval of its driver;
- discovery catalogues of databases other than Postgres;
- MQTT and OPC UA;
- the sovereign agent taking its countersigned updates (with the on-premises Fleet agent's bundles);

The tunnel's frames are defined in `app/server/src/contracts/connect-runtime/agentTunnel.contract.ts` and mirrored in `internal/protocol`.
