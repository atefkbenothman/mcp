"use server"

import { v4 as uuid4 } from "uuid"
import { CoreMessage } from "ai"

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8888"

export async function connectMCP(currentSessionId: string | null): Promise<{ sessionId: string | undefined}> {
  let sessionId = currentSessionId

  if (!sessionId) {
    sessionId = uuid4()
    console.log(`[Next Action] Generated new sessionId: ${sessionId}`)
  } else {
    console.log(`[Next Action] Using existing sessionId: ${sessionId}`)
  }

  try {
    console.log(`[Next Action] Calling ${MCP_SERVICE_URL}/connect for sessionId: ${sessionId}`)

    const response = await fetch(`${MCP_SERVICE_URL}/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId }),
      cache: "no-store"
    })

    console.log(`[Next Action] /connect response status: ${response.status}`)

    const data = await response.json()

    if (!response.ok) {
      console.error(`[Next Action] /connect failed: ${response.status}`, data)
      return { sessionId: undefined }
    }

    const alreadyConnected = data?.message === "Already connected"
    if (alreadyConnected) {
      console.log(`[Next Action] Session ${sessionId} was already connected on the service`)
    }

    return { sessionId: sessionId }

  } catch (err) {
    console.error("[Next Action] Error calling /connect:", err)
    return { sessionId: undefined }
  }
}


export async function disconnectMCP(sessionId: string | null): Promise<{ success: boolean; error?: string }> {
  if (!sessionId) {
    console.log("[Next Action] No sessionId provided for disconnect")
    return { success: true }
  }

  try {
    console.log(`[Next Action] Calling ${MCP_SERVICE_URL}/disconnect for sessionId: ${sessionId}`)

    const response = await fetch(`${MCP_SERVICE_URL}/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
      cache: "no-store"
    })

    if (!response.ok) {
      console.error(`[Next Action] /disconnect failed: ${response.status}`)
      return { success: false, error: "Disconnect failed" };
    }

    console.log(`[Next Action] /disconnect response status: ${response.status}`)
    const data = await response.json()

    console.log(`[Next Action] Disconnection successful for ${sessionId}`)
    return { success: true }
  } catch (err) {
    console.error("[Next Action] Error calling /disconnect:", err)
    return { success: false, error: "An unexpected error occurred during disconnect" }
  }
}


export async function sendChatMCP(sessionId: string | null, messages: CoreMessage[]): Promise<{ response?: string; error?: string }> {
  if (!sessionId) {
    console.warn('[Next Action] Cannot send chat, no sessionId provided')
    return { error: 'Not connected. Session ID is missing' }
  }

  if (!messages || messages.length === 0) {
    console.warn("[Next Action] Cannot send chat, message is empty")
    return { error: "Cannot send an empty message" }
  }

  try {
    console.log(`[Next Action] Calling ${MCP_SERVICE_URL}/chat for sessionId: ${sessionId}`)

    const response = await fetch(`${MCP_SERVICE_URL}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId, messages }),
        cache: "no-store",
    })

    console.log(`[Next Action] /chat response status: ${response.status}`)

    const data = await response.json()

    if (!response.ok) {
        console.error(`[Next Action] /chat failed: ${response.status}`, data)
        return { error: `Chat request failed with status: ${response.status}` }
    }

    console.log(`[Next Action] Chat successful for ${sessionId}`)
    return { response: data.response }
  } catch (err) {
    console.error("[Next Action] Error calling /chat:", err)
    return { error: "An unexpected error occurred during disconnect" }
  }
}
