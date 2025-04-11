import * as path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CoreMessage,
  generateText,
  streamText,
  LanguageModel,
  Tool,
  ToolSet,
  jsonSchema,
  GenerateTextResult,
  StreamTextResult
} from "ai"
import dotenv from "dotenv"
import { asyncTryCatch } from "./utils"
import { MCPServerConfig } from "./types"

dotenv.config({
  path: path.resolve(process.cwd(), "../.env")
})

async function generateModelResponse(model: LanguageModel, messages: CoreMessage[], tools?: ToolSet): Promise<GenerateTextResult<ToolSet, never> | null | undefined> {
  const { data: response, error } = await asyncTryCatch(generateText({
    model: model,
    messages: messages,
    tools: tools ?? {}
  }))

  if (error || !response) {
    console.error("[MCPClient] Error generating text:", error)
    return
  }

  return response
}

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

    this.transport = new StdioClientTransport({
      command: this.mcpServerConfig.command,
      args: this.mcpServerConfig.args,
      cwd: this.mcpServerConfig.cwd,
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
  public async chat(model: LanguageModel, messages: CoreMessage[]): Promise<string> {
    if (!this.client) return "Error: MCP Client not connected"

    console.log(`[MCPClient] Generating AI response based on ${messages.length} messages. Last message:`, messages[messages.length-1]?.content)

    const response = await generateModelResponse(model, messages, this.tools)

    if (!response) return "Error generating response from AI"

    let finalText = []
    let toolResults = []

    for (const message of response.response.messages) {
      for (const content of message.content) {

        if (typeof content !== "object") continue

        if (content.type === "text" || content.type == "reasoning") {
          finalText.push(content.text)
          continue
        }

        if (content.type === "tool-call") {
          console.log("[MCPClient] Calling Tool:", content)

          const { data: toolCall, error } = await asyncTryCatch(this.client.callTool({
            name: content.toolName,
            arguments: content.args as { [x: string]: unknown } | undefined
          }))

          if (error || !toolCall) {
            finalText.push(`Error calling tool: ${content.toolName} ${JSON.stringify(content.args)}: ${error}`)
            continue
          }

          finalText.push(`[Calling tool ${content.toolName} with args ${JSON.stringify(content.args)}]`)

          toolResults.push(toolCall)

          const updatedMessages = [
            ...messages,
            {
              role: "user",
              content: toolCall.content as string
            } as CoreMessage
          ]

          const finalResponse = await generateModelResponse(model, updatedMessages)

          if (finalResponse) {
            finalText.push(finalResponse.text)
          }
        }
      }
    }

    return finalText.join("\n\n")
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
