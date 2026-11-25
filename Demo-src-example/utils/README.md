# utils

Rules, not plumbing.

A util here is a decision the system makes the same way everywhere: how a secret
is sealed, what a tenant boundary means, whether a figure carries its lineage. It
holds no connections, opens no sockets and reaches nothing over the network. That
is what `infra/` is for.

## The line between utils and infra

The split is not "pure functions here, side effects there". It is **who owns the
rule**.

| | utils | infra |
| --- | --- | --- |
| Database | `tenantContext` — the rule that nothing runs untenanted | `db.infra` — the pool, which obeys it |
| Cache | key namespacing, what may persist | the Redis client |
| Object store | upload validation, SVG sanitisation, MIME sniffing | signed URLs, bucket paths |
| Secrets | `envelope`, `mediator` — the sealing scheme | `kms.infra` — the KMS client |

Three worked examples, because each one is easy to get backwards:

**`tenantContext` is not infrastructure.** It is an authorisation control that
happens to be applied at the database boundary. Put it in `infra/` and "no query
runs without a tenant" becomes a property of the database wrapper — so whoever
writes the cache client, or the object store, or the second database wrapper, has
no reason to think it applies to them. It does. The control lives here and the
infrastructure obeys it: `db.infra` refuses to execute a statement when no
context is set.

**Cache namespacing is the same argument.** The Redis client is infra. The rule
that every data-plane key carries an organisation namespace, and that data-plane
values never persist, is a decision about tenancy that would be just as true if
the cache were Memcached or a Map.

**The object store splits down the middle.** Signed URL generation and bucket
path scoping need credentials and a network — infra. Upload validation, SVG
sanitisation and MIME sniffing are rules about what is allowed to exist, and they
must run *before* anything reaches the store. A sanitiser that lives inside the
storage client is a sanitiser somebody can skip by not using that client.

## Layout

Flat. One file per module, `<name>.util.ts`, with `<name>.test.ts` in
`.test/utils/`.

No subdirectories. A util is found by name, and grouping them into `security/`,
`tenancy/`, `data/` only moves the question from "which file" to "which folder" —
and every genuinely useful util sits on the boundary of two groups anyway.
`redact` is security and observability. `bounds` is data handling and it is the
refusal guarantee. `path` is tenancy and it is a tree algorithm.

### Built

All of them. One file each, `<name>.util.ts`.

**Security** `envelope` · `mediator` · `hash` · `tokens` · `redact` · `lastFour`

**Tenancy and authorisation** `tenantContext` · `path` · `effectivePermissions` ·
`delegationCheck` · `markingCheck`

**Validation** `schemas` · `manifestValidator` · `inputSanitiser` · `mimeSniff`

**Data** `bounds` · `entityResolver` · `normalise` · `merge` · `lineage` ·
`diff` · `blastRadius` · `cursor`

**Connectors** `authStrategies` · `pagination` · `schemaDiffer` · `fileParser` ·
`emailParser`

**Metering** `tokenMeter` · `rephraseDetector` · `usageProjector` ·
`marginCalculator`

**Time** `period` · `cronParser` · `backoff` · `expiry`

**Rendering** `exporter` · `formatter`

The render layer lives in `engine/render/`, not here: `select.render` chooses the
archetype from §4.2's precedence, `prose.render` writes §2's sentences from the
result object, and `flags.render` reads §6's three flags off it.

Two utils went when it arrived. `shapeDetector` had six shapes, predating both
§3's ten and §4.2's precedence, with no caller and RECOGNITION-SPEC-V2 §11
already saying to remove it. `proseGenerator` had the right argument — assembled
from the result, never from a model's recollection — against the wrong input: it
took figures somebody had already prepared, where §2 says prose "reads the result
object and nothing else".

**Observability** `audit` · `error`

**Simulation** `dependencyGraph` · `propagate` · `scenario`

### Two that need a dependency injected

`fileParser` parses CSV itself and takes xlsx, docx and PDF readers as arguments.
`exporter` produces a neutral document and CSV, and leaves the binary writers to
infra. Both are structured that way so the heavy dependency is optional and the
rule about *what may be in the file* stays testable without it.

### What went to infra instead

Some of these read as utils and are not, because they hold a connection:

- `kms` — a KMS client. `envelope` is the scheme; this is the socket.
- `httpClient` — retries, breakers, pooling. Every outbound call.
- `oauth`, `rateLimiter`, `schemaProbe` — all reach a live system.
- `logger`, `tracer`, `metrics` — transports. The *redaction* they apply is
  `redact`, which is a util, because what counts as a secret is a rule.
- `tunnel`, `mtls`, `storeForward`, `binaryVerify` — the agent's transport.

## Rules that apply to everything here

**A util may not import from `services/`, `repos/`, `controllers/` or `routes/`.**
The dependency runs one way. A util that reaches into a service is a service.

**A util may not read the environment directly.** It takes configuration as an
argument. `env.config` is read once at boot by whatever composes these.

**The security and tenancy utils are tested without a database.** `tenantContext`,
`hash` and `error` are the controls that must never be silently skipped because a
machine has no Postgres running.

**Two names that must never be confused.** `error` distinguishes a *refusal* from
a *denial*: one is a capability signal, the other a permission signal, and a
caller that cannot tell them apart will retry the wrong one and leak the
difference to a user. See `error.util.ts`.

The names above that are not yet written are written down so the first person who
needs `normalise` adds it in one place, rather than inventing a second one beside
the caller.
