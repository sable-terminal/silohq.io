/*
 * 083 — what an organisation calls a concept, and what one person calls it.
 *
 * ── §12: "Terminology skins per organisation. Per-user lens on presentation." ─
 *
 * A recruiter says Placement, a law firm says Matter, a defence programme says
 * Programme, and the ontology says Deal. All four are the same concept and must
 * resolve across systems as one, so the skin cannot be a rename: it is a word
 * laid over a concept whose identity never changes.
 *
 * ── PRESENTATION ONLY, AND THAT IS THE WHOLE CONSTRAINT ────────────────────
 *
 * Nothing here may reach the compiler, the plan, the manifest or a mapping. If
 * a skin changed what the engine matched on, then renaming Deal to Matter would
 * silently rewrite every saved question in the organisation, and two customers
 * asking the same thing would compile to different plans. The canonical name
 * stays canonical everywhere it is used to decide something; the skin is only
 * ever added beside it for a reader.
 *
 * ── TWO LAYERS, RESOLVED IN ONE ORDER ──────────────────────────────────────
 *
 * The person's lens wins over the organisation's skin, which wins over the
 * concept's own name. A lens is somebody's own preference and needs no
 * permission; a skin changes what every reader in the organisation sees and
 * therefore does.
 */

CREATE TABLE terminology (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  /* What this organisation calls it. Never written back to `concepts.name`. */
  term            text        NOT NULL CHECK (length(trim(term)) BETWEEN 1 AND 64),

  set_by          uuid        NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  set_at          timestamptz NOT NULL DEFAULT now(),

  /* One word per concept per organisation. A second is a disagreement, and the
     resolution is somebody deciding rather than the database keeping both. */
  UNIQUE (organisation_id, concept_id)
);

/*
 * §12 — the per-user lens.
 *
 * SOMEBODY'S OWN WORD FOR SOMETHING IS THEIR BUSINESS. It overrides the
 * organisation's skin for them alone and is invisible to everybody else, which
 * is why it carries no `set_by`: the membership IS who set it.
 */
CREATE TABLE presentation_lenses (
  id              uuid        PRIMARY KEY,
  organisation_id uuid        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  membership_id   uuid        NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  concept_id      uuid        NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,

  term            text        NOT NULL CHECK (length(trim(term)) BETWEEN 1 AND 64),
  set_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (membership_id, concept_id)
);

CREATE INDEX terminology_by_org ON terminology (organisation_id);
CREATE INDEX presentation_lenses_by_membership ON presentation_lenses (membership_id);

ALTER TABLE terminology ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminology FORCE  ROW LEVEL SECURITY;
CREATE POLICY terminology_tenant ON terminology
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

ALTER TABLE presentation_lenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE presentation_lenses FORCE  ROW LEVEL SECURITY;
CREATE POLICY presentation_lenses_tenant ON presentation_lenses
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON terminology TO silo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON presentation_lenses TO silo_app;

/*
 * SUPER ADMIN ONLY, FOR THE REASON THE ONTOLOGY PERMISSIONS ARE. A skin applies
 * to every reader in the organisation, and a scope admin administers part of a
 * network — letting them decide what the whole organisation calls a concept is
 * the same overreach as letting them authorise a scan of scopes they do not
 * administer.
 *
 * A lens needs no permission at all, because it changes nothing anybody else
 * can see.
 */
INSERT INTO permissions (id, category, description, scopeable) VALUES
  ('terminology.manage', 'organisation', 'Set what this organisation calls a concept', false);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'terminology.manage'
  FROM roles r
 WHERE r.system_role AND r.name = 'Super admin'
ON CONFLICT DO NOTHING;
