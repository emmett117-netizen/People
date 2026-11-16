# People nightly job

Runs every evening on GitHub (no phone, Mac or Claude needed):

1. Applies any update files Claude left in the vault's `Claude updates` folder.
2. Fixes one-sided connections (if A lists B, B gets A back, with the matching relationship).
3. Lists links to people with no note and phone numbers shared by two people.
4. Pushes names, phones, emails, birthdays and work to Google Contacts — only when the repository variable `CONTACTS_SYNC` is `on`. It only adds; it never deletes.
5. Writes `People report.md` into the vault with the details.

The log only shows counts, because this repository is public. Names and contact details stay in Google Drive.

Secrets it needs (Settings → Secrets and variables → Actions): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `VAULT_FOLDER_ID`.
Run it by hand from the Actions tab → People nightly → Run workflow (tick "Check only" for a dry run).
