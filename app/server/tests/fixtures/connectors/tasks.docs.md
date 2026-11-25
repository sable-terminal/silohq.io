# Tasks API

Every request carries your API key in the X-Api-Key header.

## Projects

GET /api/projects lists projects. The response is an object: items holds the projects, page is
the page number and total_pages the number of pages. Ask for a page with the page query
parameter, starting at 1, and set the page size with per_page.

A project has an id (a number), a name, and archived (true or false).

## Tasks

GET /api/tasks lists tasks, paged exactly as projects are. A task has an id (a number), the
project_id of its project, a title, done (true or false) and due, a date.
