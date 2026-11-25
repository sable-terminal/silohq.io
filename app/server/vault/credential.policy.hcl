# The Vault policy for the credential service (decision 2026-10-29).
#
# Vault is for development only. Production uses Cloud KMS in commercial cells and the
# UK HSM in the sovereign cell. A Vault for the sovereign cell would have to be backed
# by the UK HSM, which waits on the sovereign-provider decision.
#
# Keys come from Terraform only. This policy can use a key and read its metadata, never
# create, change or delete one. Vault denies whatever a policy does not grant, so:
# - transit/keys/* grants read only, so no create, update (rotate, config) or delete;
# - encrypt grants update, not create, so encrypting under a missing key fails instead
#   of creating it (Vault creates the key when the caller has create on that path).
# An explicit "deny" is not used: it would also deny the metadata read the start-up
# check makes, which shares the path with create and delete.
#
# The mount is "transit"; change the paths if VAULT_TRANSIT_MOUNT differs.

path "transit/keys/*" {
  capabilities = ["read"]
}

path "transit/encrypt/*" {
  capabilities = ["update"]
}

path "transit/decrypt/*" {
  capabilities = ["update"]
}

path "transit/hmac/*" {
  capabilities = ["update"]
}
