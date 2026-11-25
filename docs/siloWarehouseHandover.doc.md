# Taking your Silo Warehouse with you

For a customer's Google Cloud administrator, when their organisation takes its Silo Warehouse
into its own Google Cloud organisation (specification 69.17). It covers what to prepare, what
Silo does at hand-over, and how to put the data under your own encryption key afterwards. Until
you re-key, the data is still encrypted with Silo's key.

## What you are taking

Silo built your Warehouse in a Google Cloud project used only by your organisation. The project
holds:
- a BigQuery dataset named `warehouse`, with the current state and change history of the fields
  you chose;
- the Action ledger, if you switched it on.

The dataset is encrypted with a customer-managed Cloud KMS key that Silo created for your
organisation alone. That key sits in Silo's key project.

Hand-over moves the whole project into your Google Cloud organisation. If you would rather have
files, ask instead for an export: every table as Parquet, with its schema and lineage.

## Before hand-over

1. Choose the folder or organisation in your Google Cloud that will receive the project. Note its
   resource name, such as `folders/123456789` or `organizations/123456789`.
2. Allow the move into that destination: let Silo's project be moved in under your organisation
   policy, and give Silo's mover the permission to create a project there for the move. Your
   Silo contact gives you the exact identity to grant.
3. In Silo, someone holding `silo.purge` opens the Warehouse in Siloes and chooses "Hand over",
   naming the destination.

## What Silo does at hand-over

- Ends every direct SQL grant it had given your people on the dataset.
- Removes its own service accounts from the dataset and the project, so it can no longer read or
  write your data.
- Moves the project into your destination.
- Marks the Warehouse handed over and stops syncing to it. The handed-over Warehouse no longer
  answers questions in Silo.
- Records `warehouse_handed_over` in your audit log.

If the move fails, Silo's writers are restored and the Warehouse carries on syncing; nothing is
lost. You can try again.

## After hand-over: re-key to your own key

The data is still encrypted with Silo's key. Silo keeps that key enabled so you can read your
data, but you should not depend on another company's key. Re-key as soon as you can.

The steps below use the `gcloud` and `bq` tools, in the same location as the dataset (shown in
BigQuery as the dataset's location, for example `europe-west2`).

1. **Create your own key** in a project you control:

       gcloud kms keyrings create silo-warehouse --location=LOCATION
       gcloud kms keys create warehouse --keyring=silo-warehouse --location=LOCATION --purpose=encryption

2. **Let BigQuery in the handed-over project use it.** Find the project's BigQuery service agent
   (`bq show --encryption_service_account --project_id=PROJECT`), then:

       gcloud kms keys add-iam-policy-binding warehouse --keyring=silo-warehouse --location=LOCATION \
         --member=serviceAccount:SERVICE_AGENT --role=roles/cloudkms.cryptoKeyEncrypterDecrypter

3. **Make it the dataset's default key**, so new tables use it:

       ALTER SCHEMA `PROJECT.warehouse` SET OPTIONS (
         default_kms_key_name = 'projects/KEY_PROJECT/locations/LOCATION/keyRings/silo-warehouse/cryptoKeys/warehouse');

4. **Re-encrypt every table** with your key. Run this for each table the next query lists:

       ALTER TABLE `PROJECT.warehouse.TABLE` SET OPTIONS (
         kms_key_name = 'projects/KEY_PROJECT/locations/LOCATION/keyRings/silo-warehouse/cryptoKeys/warehouse');

5. **Check that nothing still uses Silo's key:**

       SELECT table_name, option_value FROM `PROJECT.warehouse`.INFORMATION_SCHEMA.TABLE_OPTIONS
       WHERE option_name = 'kms_key_name';

   Every row should show your key.

6. **Tell Silo, in writing,** that re-keying is done.

   Wait seven days first. BigQuery keeps earlier versions of each table for time travel and
   fail-safe recovery for up to seven days, and those are still under Silo's key until they
   expire.

   Silo then:
   - removes your project's access to its key;
   - schedules that key for destruction;
   - confirms both in writing.

   From then on, only your key can read the data.

## Your responsibilities after hand-over

The project is yours from the moment it moves. Your organisation's policies, your access
controls, your billing and your retention apply. Silo keeps the Warehouse's record (its purpose,
what it held and the hand-over), but no copy of the data.

The Silo Warehouse's own retention window no longer applies. You decide how long to keep the data,
as controller.
