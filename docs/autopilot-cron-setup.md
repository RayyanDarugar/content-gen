# Autopilot cron setup

Autopilot needs one cron job, registered once by the operator. Tenants
configure nothing — a single tick sweeps every tenant's workflows.

At cron-job.org, alongside the existing `/api/jobs/poll` job:

- **URL:** `https://<your-domain>/api/jobs/autopilot`
- **Method:** GET
- **Schedule:** every 5 minutes
- **Header:** `Authorization: Bearer <CRON_SECRET>` — the same secret the poll
  job uses, read from the `CRON_SECRET` environment variable.

The route fails closed: with `CRON_SECRET` unset it returns 401 to everyone,
so a misconfigured deploy silently does nothing rather than running unguarded.

Why 5 minutes and not 60 seconds like the poll job: a tick may spend ~90s
generating ideas, and nothing autopilot does is latency-sensitive — a daily
quota has all day. Why a separate job at all: the poll job's 120s budget is
already committed to image ingestion.

A healthy response is `{"workflowsExamined":N,"runsOpened":…,"runsAdvanced":…,"errors":[]}`.
Entries in `errors` are per-workflow failures that did not stop the sweep.
