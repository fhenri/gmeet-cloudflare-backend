# Gmeet Cloudflare backend
This is the backend cloudflare workers to integrate with Google Calendar API for our meeting page

# Features
The API exposes 2 endpoints:
- GET `/available-slots` it takes a date parameter and will return available slots for this date
- POST `/create-meeting` it push the form data (date, time, email and description) and will create a meeting in a given calendar

# Technical Corner

The development of the page is explained in this [medium article](https://medium.com/@frederic.henri/integrate-google-calendar-from-cloudflare-pages-9661528a2e84)

## Stack

- [Cloudflare workers](https://developers.cloudflare.com/workers/get-started/guide/)
- It integrates with Google Calendar, you need to configure a Google Service Account and your Google Calendar (see the [article](https://medium.com/@frederic.henri/nextjs-application-to-manage-your-google-calendar-and-your-invites-28dce1707b24) for a step by step guide

## Deployment

deployed as cloudflare worker with wrangler.
