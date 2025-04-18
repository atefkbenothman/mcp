import * as path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CoreMessage,
  streamText,
  LanguageModel,
  Tool,
  ToolSet,
  jsonSchema,
  ToolCallPart,
  ToolResultPart
} from "ai"
import dotenv from "dotenv"
import { asyncTryCatch } from "./utils"
import { MCPServerConfig } from "./types"

dotenv.config({
  path: path.resolve(process.cwd(), ".env")
})


export class MCPClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private mcpServerConfig: MCPServerConfig | null = null
  private tools: ToolSet | undefined = undefined

  constructor(serverConfig: MCPServerConfig) {
    this.mcpServerConfig = serverConfig
    console.log(`[MCPClient] MCPClient configured for service ${this.mcpServerConfig.displayName}`)
  }

  /* Start */
  public async start(): Promise<void> {
    if (this.client || !this.mcpServerConfig) return

    this.client = new Client({
      name: "mcp-client",
      version: "1.0.0"
    })

    const parentEnv = { ...process.env }
    const configEnv = this.mcpServerConfig.env || {}

    const envs: Record<string, string> = {
      ...parentEnv,
      ...configEnv,
      PATH: configEnv.PATH || parentEnv.PATH || ""
    }

    this.transport = new StdioClientTransport({
      command: this.mcpServerConfig.command,
      args: this.mcpServerConfig.args,
      cwd: this.mcpServerConfig.cwd,
      env: envs,
    })

    const { error: connectError } = await asyncTryCatch(this.client.connect(this.transport))

    if (connectError) {
      console.error("[MCPClient] Failed to connect MCP client: ", connectError)
      this.client = null
      this.transport = null
      throw connectError
    }

    const { data: allTools, error: allToolsError } = await asyncTryCatch(this.client.listTools())

    if (allToolsError || !allTools) {
      console.error("[MCPClient] Failed to fetch tools from MCP server:", allToolsError)
      this.tools = {} as ToolSet
      return
    }

    this.tools = allTools.tools.reduce((acc, tool) => {
      acc[tool.name] = {
        description: tool.description,
        parameters: jsonSchema(tool.inputSchema)
      } as Tool
      return acc
    }, {} as ToolSet)

    console.log("[MCPClient] Connected to server with tools: ", Object.values(this.tools).map(tool => tool.description))
  }

  /* Chat */
  public async chat(model: LanguageModel, messages: CoreMessage[]): Promise<ReadableStream<string>> {
    if (!this.client) {
      return new ReadableStream({
        start(controller) {
            controller.error(new Error("Error: MCP Client not connected"))
            controller.close()
        }
      });
    }

    console.log(`[MCPClient] Generating AI response based on ${messages.length} messages. Last message:`, messages[messages.length-1]?.content)

    const mcpClient = this.client
    const tools = this.tools || {}
    let currentMessages = [...messages]

    const readableStream = new ReadableStream<string>({
      async start (controller) {
        let loopCounter = 0

        while (true) {
          loopCounter += 1
          console.log(`[MCPClient.chat] Loop ${loopCounter}: Starting streamText call with ${currentMessages.length} messages.`)

          let toolCallsToExecute: ToolCallPart[] = []
          let capturedText = ""
          let assistantTurnContent: Array<{ type: "text", text: string } | ToolCallPart> = []
          let currentTurnHadToolCall = false

          try {
            console.log("[MCPClient.chat] Phase 1: Initial streamText call...")

            const currentResult = await streamText({
              model: model,
              messages: currentMessages,
              tools: tools
            })

            for await (const part of currentResult.fullStream) {
              switch (part.type) {
                case "text-delta":
                  controller.enqueue(part.textDelta)
                  capturedText += part.textDelta
                  break
                case "tool-call":
                  currentTurnHadToolCall = true
                  controller.enqueue(`**Calling Tool: ${part.toolName}(${JSON.stringify(part.args)})**\n\n`)
                  toolCallsToExecute.push(part)
                  break
              }
            }
            console.log(`[MCPClient.chat] Loop ${loopCounter}: streamText finished.`)

            if (capturedText.trim()) {
              assistantTurnContent.push({ type: "text", text: capturedText.trim() })
            }

            assistantTurnContent.push(...toolCallsToExecute)

            if (assistantTurnContent.length === 0) {
              console.warn(`[MCPClient.chat] Loop ${loopCounter}: Assistant message content was empty.`)
            }

            currentMessages.push({
              role: "assistant",
              content: assistantTurnContent
            })

            // Check loop condition: If NO tools were called in THIS turn, break the loop
            if (!currentTurnHadToolCall) {
              console.log(`[MCPClient.chat] Loop ${loopCounter}: No tool calls in this turn. Ending loop.`)
              break
            }

            // Tools were called, execute them
            console.log(`[MCPClient.chat] Loop ${loopCounter}: Executing ${toolCallsToExecute.length} tool(s)...`)

            const toolResults: ToolResultPart[] = []

            for (const toolCall of toolCallsToExecute) {
              let resultData: unknown = null
              let isResultError = false

              const { data, error } = await asyncTryCatch(mcpClient.callTool({
                name: toolCall.toolName,
                arguments: toolCall.args as { [x: string]: unknown } | undefined
              }))

              if (error || !data) {
                resultData = `Error: ${error}`
                isResultError = true
              } else {
                resultData = data.content
              }

              toolResults.push({
                type: "tool-result",
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                result: resultData,
                isError: isResultError
              })
            }

            currentMessages.push({ role: "tool", content: toolResults })

          } catch (err) {
            console.error(`[MCPClient.chat] Loop ${loopCounter}: Error during processing:`, err)
            controller.enqueue(`\n[STREAM ERROR]: ${err}`);
            controller.close()
            return
          }
        }

        console.log("[MCPClient.chat] Loop finished. Stream process complete.")
        controller.close()
      }
    })

    return readableStream
  }

  /* Direct chat */
  static async directChat(model: LanguageModel, messages: CoreMessage[]): Promise<Response> {
    console.log(`[MCPClient] MCPClient.directChat (static): Using direct AI call for ${messages.length} messages`)

    const result = await streamText({
      model: model,
      messages: messages
    })

    return result.toTextStreamResponse()
  }

  /* Clean up */
  public async cleanup() {
    if (this.client) {
      console.log("[MCPClient] Cleaning up and closing MCPClient")
      await this.client.close()
      this.client = null
      this.transport = null
    }
  }
}
