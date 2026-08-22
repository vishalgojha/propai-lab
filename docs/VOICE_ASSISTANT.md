# PropAI in-app voice assistant

The app dashboard pilot uses the official ElevenLabs React Agents SDK for
browser audio, turn handling, and client tools. The widget is intentionally
limited to WhatsApp setup assistance.

## Runtime configuration

Configure these as frontend runtime environment variables in the app
deployment. They are public client identifiers, not secrets:

```text
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=...
```

The agent ID is a public client identifier. Do not put an ElevenLabs API key or
Supabase service key in the frontend. If the ElevenLabs agent is configured to
require authentication, use ElevenLabs' signed/authenticated session flow from
the server rather than exposing a private key.

The ElevenLabs agent should use the validated PropAI voice, with a
multilingual transcriber configured for Hindi-English code-switching. The
assistant prompt must describe the three client tools in
`frontend/src/components/VoiceAssistant.tsx` and must not add mutation tools.

## Hard action boundary

The widget can:

- open the WhatsApp number-connection screen;
- read the signed-in tenant's connection and group status;
- open group review for the broker to make the final selection.

It cannot scan/authorize a QR code, select or confirm groups, edit extracted
data, send a WhatsApp message, delete data, or accept a tenant ID from the
model. All navigation and read-status actions are performed through the
existing authenticated frontend APIs, which attach the active tenant context.

Every executed tool action writes to the existing workspace activity log with
`details.source = "voice_assistant"`.

## Assistant tool registry

The ElevenLabs agent must expose exactly these client tools:

- `open_whatsapp_connect`
- `get_whatsapp_setup_status`
- `open_group_selection`

The browser handler blocks any name outside this registry. If the assistant is
not configured, the widget remains visible but reports that setup is pending;
it does not silently fall back to an untracked voice service.

## Pilot test phrases

Verify mixed-language turns before enabling the pilot broadly:

- “WhatsApp connect screen khol do, QR main khud scan karunga.”
- “Mera group selection status batao, kitne groups selected hain?”
- “Groups page khol do, lekin select tum mat karna — main confirm karunga.”

The expected behavior is visible text plus voice feedback, with no consent or
data mutation performed by the assistant.
