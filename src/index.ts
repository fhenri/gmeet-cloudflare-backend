/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { calendar_v3 as googleCalendar } from "@googleapis/calendar";
import { add, format, parse, formatISO, isBefore,  isAfter } from "date-fns";
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const availableSlots = ["08:00", "08:20", "08:40", "09:00", "09:20", "09:40"]
const OAUTH_SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events";

interface Env {
    CALENDAR_ID: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_EMAIL: string;
    GOOGLE_PROJECT_ID: string;
    GOOGLE_PRIVATE_KEY: string;
}

/**
 * Get a Google auth token given service user credentials. This function
 * is a very slightly modified version of the one found at
 * https://community.cloudflare.com/t/example-google-oauth-2-0-for-service-accounts-using-cf-worker/258220
 *
 * @param {string} user   the service user identity, typically of the
 *   form [user]@[project].iam.gserviceaccount.com
 * @param {string} key    the private key corresponding to user
 * @param {string} scope  the scopes to request for this token, a
 *   listing of available scopes is provided at
 *   https://developers.google.com/identity/protocols/oauth2/scopes
 * @returns a valid Google auth token for the provided service user and scope or undefined
 */
async function getGoogleAuthToken(user, key, scope) {
	function objectToBase64url(object) {
	  return arrayBufferToBase64Url(
		new TextEncoder().encode(JSON.stringify(object)),
	  )
	}
	function arrayBufferToBase64Url(buffer) {
	  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
	}
	function str2ab(str) {
	  const buf = new ArrayBuffer(str.length);
	  const bufView = new Uint8Array(buf);
	  for (let i = 0, strLen = str.length; i < strLen; i++) {
		bufView[i] = str.charCodeAt(i);
	  }
	  return buf;
	};
	async function sign(content, signingKey) {
	  const buf = str2ab(content);
	  const plainKey = signingKey
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/(\\r\\n|\\n|\\r)/gm, "")
		.replace(/(\s+)/g, "");
	  const binaryKey = str2ab(atob(plainKey));
	  const signer = await crypto.subtle.importKey(
		"pkcs8",
		binaryKey,
		{
		  name: "RSASSA-PKCS1-V1_5",
		  hash: { name: "SHA-256" }
		},
		false,
		["sign"]
	  );
	  const binarySignature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-V1_5" }, signer, buf);
	  return arrayBufferToBase64Url(binarySignature);
	}

	const jwtHeader = objectToBase64url({ alg: "RS256", typ: "JWT" });
	try {
	  const assertiontime = Math.round(Date.now() / 1000)
	  const expirytime = assertiontime + 3600
	  const claimset = objectToBase64url({
		"iss": user,
		"scope": scope,
		"aud": "https://oauth2.googleapis.com/token",
		"exp": expirytime,
		"iat": assertiontime
	  })

	  const jwtUnsigned = jwtHeader + "." + claimset
	  const signedJwt = jwtUnsigned + "." + (await sign(jwtUnsigned, key))
	  const body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + signedJwt;
	  const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
		  "Content-Type": "application/x-www-form-urlencoded",
		  "Cache-Control": "no-cache",
		  "Host": "oauth2.googleapis.com"
		},
		body: body
	  });
	  const oauth: { access_token: string } = await response.json();
	  return oauth.access_token;
	} catch (err) {
	  console.error(err)
	}
  }

const initGoogleCalendar = async (env: {
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_EMAIL: string;
    GOOGLE_PROJECT_ID: string;
    GOOGLE_PRIVATE_KEY: string;
}) => {
	try {
		const credentials = {
		client_id: env.GOOGLE_CLIENT_ID,
		client_email: env.GOOGLE_CLIENT_EMAIL,
		project_id: env.GOOGLE_PROJECT_ID,
		private_key: env.GOOGLE_PRIVATE_KEY
		}

		const auth = await getGoogleAuthToken(
			credentials.client_email,
			credentials.private_key,
			OAUTH_SCOPES
		);

		return auth;
	} catch (error) {
		console.error("Error initializing Google Calendar API:", error);
	}
}

const buildDateSlots = async (date: Date) => {
	const dateSlots = availableSlots.map(slot => {
		const cetDateTime = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		+slot.slice(0, 2),
		+slot.slice(3, 5)
		);
		return fromZonedTime(cetDateTime, 'Europe/Paris');
	})
	return dateSlots
}

export default {
	async fetch(request, env, ctx): Promise<Response> {

		const calendarId = env.CALENDAR_ID

		const url = new URL(request.url);
        const path = url.pathname;

		// Set CORS headers
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle preflight requests
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: corsHeaders,
				status: 204, // No content
			});
		}

        if (request.method === 'GET' && path === '/gmeet-api/available-slots') {
			const authToken = await initGoogleCalendar(env);

            // Handle the request to get available slots
            const date = url.searchParams.get('date') as string;
			const dateString = format(date, 'yyyyMMdd')
			const dayDate = parse(dateString, 'yyyyMMdd', new Date())
			console.log(`getting events on ${dayDate}`)

			const urlParams = new URLSearchParams({
				timeMin: dayDate.toISOString(),
				timeMax: add(dayDate, { days: 1 }).toISOString(),
				singleEvents: 'true',
				orderBy: 'startTime'
			});
			// https://developers.google.com/calendar/api/v3/reference/events/list
			const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${urlParams}`, {
				method: "GET",
				headers: {
				  "Authorization": `Bearer ${authToken}`,
				  "Cache-Control": "no-cache",
				},
			});
			const results = await response.json()

			// Add a timeout of 5 seconds before returning the available slots
			//await new Promise(resolve => setTimeout(resolve, 5000));

			const events = results?.items || [];
			const dateSlots = await buildDateSlots(dayDate);

			const slots = dateSlots.filter(slot => {
			  const slotEnd = add(slot, { minutes: 20 });

			  // Check if this slot conflicts with any existing event
			  const hasConflict = events.some((event: googleCalendar.Schema$Event) => {
				const eventStart = new Date(event.start?.dateTime || '');
				const eventEnd = new Date(event.end?.dateTime || '');
				return isBefore(slot, eventEnd) && isAfter(slotEnd,eventStart)
			  });

			  return !hasConflict;
			});

			const availableSlots = slots.map(slot => {
				return format(toZonedTime(slot, 'Europe/Paris'), 'HH:mm')
			})
			console.log('availableSlots', availableSlots)

			// Convert available Date objects to string time slots
            return new Response(JSON.stringify({ availableSlots }), {
                headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
                status: 200,
            });
        }

        if (request.method === 'POST' && path === '/gmeet-api/create-meeting') {
            const formData = await request.formData();

			const dateString = formData.get("selectedDate") as string;
			const timeString = formData.get("timetable") as string;
			if (!timeString && availableSlots.includes(timeString)) {
				return new Response(JSON.stringify({ message: 'No correct time slot selected' }), {
					headers: {
						'Content-Type': 'application/json',
						...corsHeaders,
					},
					status: 404,
				});
			}
			const invitee = formData.get("email") as string;

			// Parse the date and time in CET timezone
			console.log('startDataTime:', dateString)
			const cetDateTime = parse(`${dateString} ${timeString}`, 'dd/MM/yyyy HH:mm', new Date());
			console.log('startDataTime:', cetDateTime)
			const utcDate = fromZonedTime(cetDateTime, 'Europe/Paris');
			console.log('startDataTime:', utcDate)

			// Convert date to UTC
			const startDateTime = new Date(utcDate.toUTCString());
			const endDateTime = add(startDateTime, { minutes: 20 });

			console.log('startDataTime:', startDateTime)
			console.log('endDateTime:', endDateTime)

			const event = {
				summary: `Call with ${invitee}`,
				description: formData.get("message"),
				start: {
				  dateTime: formatISO(startDateTime),
				  timeZone: "UTC",
				},
				end: {
				  dateTime: formatISO(endDateTime),
				  timeZone: "UTC",
				},
				/*
				attendees: [
					{ email: "frederic.henri+test@gmail.com" },
				],
				*/
				//sendUpdates: 'all', // Sends email invite to attendees
				conferenceData: {
				  createRequest: {
					requestId: Math.random().toString(36).substring(7),
					conferenceSolutionKey: {
					  type: "hangoutsMeet",
					},
				  },
				},
				reminders: {
				  // you can add this if you want to override the calendar reminder.
				  useDefault: false,
				  overrides: [
					{
					  method: "email",
					  minutes: 30,
					},
				  ],
				},
			  };

			  const authToken = await initGoogleCalendar(env);
			  // https://developers.google.com/calendar/api/v3/reference/events/insert
			  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
				method: "POST",
				headers: {
				  "Authorization": `Bearer ${authToken}`,
				  "Content-Type": "application/x-www-form-urlencoded",
				  "Cache-Control": "no-cache",
				},
				body: JSON.stringify(event),
			});
			const meetingData = await response.json()

			console.log(meetingData)
            return new Response(JSON.stringify({ message: 'Meeting created successfully!', data: meetingData }), {
                headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
                status: 201,
            });
        }

        return new Response('Not Found', { status: 404 });
    },
} satisfies ExportedHandler<Env>;
