# Silo certification readiness

For the founders and whoever leads compliance. Chapter 65 lists every certification target as
"not started". This pack sets out, for each one, what the platform already gives an auditor as
evidence and what only the company can do. None of the targets can be completed by code: each
needs policies, people, an assessor and, for SOC 2, time.

Settled 23 November 2026.

## Order

Chapter 65's open proposal, which this pack follows:
1. Cyber Essentials Plus first. It is the quickest, it covers the corporate estate, and the
   on-hold design-partner letters of intent ask for it.
2. ISO/IEC 27001 and SOC 2 Type II readiness in parallel.
3. SOC 2's observation window opens as soon as the controls operate. Time to enterprise revenue
   is limited by that window, not by the build.

Still open for the founders: whether the sovereign cell has its own assurance scope or sits in the
company-wide scope with added controls (65.4).

## Before any customer signs (65.3)

The terms, privacy notice and data processing agreement name Silo Data Technology Ltd (company
16676782). They must be reissued under Silo Technologies Ltd. This is a legal task, not an audit
one, and it blocks the first contract.

## What the platform gives an auditor

Each line points at where an auditor can see the control working.

| Control area | What is built | Evidence |
|---|---|---|
| Access control and least privilege | Roles, scopes and permissions decided by the policy service on every request (57.1); markings and clearances; purposes; field policies; separation of duties (no self-approval) | Permission catalogue (76); `gov.*` tables; the audit events of every grant and revocation |
| Strong authentication | Passwords with MFA (TOTP, security keys), SSO by OIDC and SAML, SCIM provisioning, session limits per organisation | `iam.*`; auth events |
| Staff access | No standing access. Break-glass sessions needing two staff approvals and, where contracted, the customer; the audit trail is the session's record (13.3, decision 23 November 2026) | `platform.operator_access_sessions`; the customer's audit log shows each session and every request |
| Audit logging | Every change writes its audit event in the same transaction. A daily hash-chain head is published to the customer; storage is insert-only | `audit.audit_events`, the chain walk in Governance; outbox backlog paging |
| Encryption | Envelope encryption under per-organisation keys in KMS or an HSM (Thales Luna on the sovereign cell). Record values sealed at rest; TLS 1.3 with mTLS between services; customer-managed keys for Warehouse datasets | Chapter 60 and 61 design; `iam.credential_unwraps` records every secret unwrap |
| Data minimisation and retention | No record values persist by default. Siloes only by an organisation's choice, each with its purpose, retention, disclosure and purge | Siloes page; retention sweeps; purge receipts |
| Deletion | Purges with receipts. The purge ledger is replayed after any restore, so deleted data never returns (8.2; D251) | `siloes.purge_receipts`, `action.receipt_purges`, `files.file_deletions`; `cell/purge-ledger/` in object-backup |
| Change management | Releases signed and promoted by two people; SBOM checked against vulnerability data (OSV, with VEX) before stable; health gates roll a release back | Fleet's hash-chained events; release documents |
| Availability | SLOs, paging, incident process, backups, restore checks and recovery exercises | `docs/siloOperations.doc.md`; the monthly restore test results |
| Tenancy isolation | Row-level security on every tenant table under a per-transaction organisation context; cells per residency; the sovereign build off US-owned providers | Architecture tests; `tests/db` RLS tests |
| Telemetry hygiene | No record value, secret or prompt in logs, spans or metrics: typed logging, redaction, a scan that pages on a match | Redaction signals; logging tests |
| Supply chain of AI | Zero-retention model endpoints only, in the cell's residency; record values reach a model only under the documented carve-out, acknowledged per Silo (62.5, 70.7) | Model routes configuration; `extraction_carveout_acknowledged` events |

## Each target

| Target | Scope (65.2) | The platform's part | The company's part |
|---|---|---|---|
| Cyber Essentials, then Plus | The corporate estate | Little: the estate is laptops, accounts and offices, not the product | Device management, patching, MFA on corporate accounts, firewalls, malware protection; the self-assessment; then the Plus audit by a certification body |
| ISO/IEC 27001 | An ISMS covering the platform, all cells and staff | The controls above map to most of Annex A's technological controls (A.8); the audit trail and Fleet evidence cover operations | The ISMS itself: scope, risk assessment, statement of applicability, policies (access, supplier, incident, business continuity, HR security), internal audit, management review; stage 1 and stage 2 audits |
| SOC 2 Type II | Security, availability and confidentiality, commercial cells | The controls above, operating, produce the evidence over the window: access reviews, change approvals, incident records, restore tests | Choose an auditor and a readiness assessment; run the controls for the observation window (usually 6 to 12 months); quarterly access reviews; vendor management |
| UK GDPR and DPA 2018 | Processor for customer data; controller for staff and account data | 65.3's processing position as built: what persists, the carve-out, purge, erasure as an Action; sub-processor list per cell | Records of processing; DPA (reissued, above); DPIA template for customers enabling Siloes; data protection officer or lead; breach procedure within 72 hours |
| NCSC Cloud Security Principles | Self-assessment per cell, 14 principles | Principles 1 (data in transit), 2 (asset protection, residency), 3 (separation between customers), 5 (operational security), 9 (secure user management), 10 (identity), 13 (audit) are largely evidenced by the build | The written self-assessment per cell, including principles 4 (governance), 6 (personnel), 7 (development), 8 (supply chain), 11 (interfaces), 12 (service administration), 14 (secure use) |
| G-Cloud listing | Crown Commercial Service, next iteration | The service description draws on the specification and this pack | The application at the next open iteration |
| DCPP Cyber Security Model and DEFSTAN 05-138 | Per the contracting authority's risk profile | As for ISO 27001 | Risk assessment questionnaire per contract; controls at the required profile |
| JOSCAR | Aerospace, defence and security pre-qualification | None | Registration |
| OFFICIAL and OFFICIAL-SENSITIVE | The sovereign cell only | Sovereign build: UK-resident, off US-owned providers, its own HSM, rota and status page | Accreditation of the sovereign site and its operators; SC clearances (65.4) |

## People (65.4)

- BPSS for everyone with production access.
- SC for sovereign operators and anyone with Fleet deployment rights to the sovereign cell.
- DV where a contract requires it.

The break-glass route already checks a sovereign operator's clearance before any grant. Vetting
itself is an HR programme to start.

## Next steps

1. Reissue the terms, privacy notice and DPA under Silo Technologies Ltd.
2. Book Cyber Essentials, then Plus.
3. Appoint an ISMS owner, and choose an ISO 27001 certification body and a SOC 2 auditor.
   Start the risk assessment from this pack.
4. Stand up what `docs/siloOperations.doc.md` section 9 lists. The SOC 2 window opens when those
   operate.
5. Decide the sovereign cell's assurance scope.
