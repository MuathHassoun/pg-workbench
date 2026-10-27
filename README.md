# Local DB Studio

A standalone interface for managing a local PostgreSQL database. It supports schema and table browsing, column inspection, paged table data, row insert/update/delete, CSV export, and real SQL execution.

## Run

PostgreSQL is not bundled or installed by this interface. Install and start PostgreSQL separately if it is not already available. From this folder, install the PostgreSQL Node.js client and start the interface:

```sh
npm install
npm start
```

Open `http://127.0.0.1:4173`, then enter the local PostgreSQL host, port, database, username, and password. The host must be `localhost`, `127.0.0.1`, or `::1`.

## Project layout

```text
db-integration/
├── client/          # Browser interface: HTML, CSS, and JavaScript
├── server/          # Local HTTP server and PostgreSQL API
├── package.json     # Scripts and runtime dependencies
└── README.md        # Setup, architecture, and safety notes
```

## Security and scope

- The interface server binds to `127.0.0.1` only and refuses database hosts outside loopback.
- Connection credentials stay in process memory and are not written to disk or browser storage. Stop the server to clear them.
- SQL runs with the permissions of the PostgreSQL user you provide. Potentially mutating statements prompt for confirmation, but SQL can still alter or delete data. Back up important databases and use an appropriately scoped account.
- The table viewer fetches up to 100 rows per page. Row totals are PostgreSQL estimates and may be approximate.
- The PostgreSQL server itself is separate from this interface; only the `pg` client library is installed by `npm install`.
