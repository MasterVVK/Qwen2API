const { generateUUID } = require('../utils/tools.js')
const { isChatType, isThinkingEnabled, parserModel, parserMessages } = require('../utils/chat-helpers.js')
const { buildToolSystemPrompt, foldToolMessages } = require('../utils/tool-prompt.js')
const { logger } = require('../utils/logger')

/**
 * 处理聊天请求体的中间件
 * 解析和转换请求参数为内部格式
 */
const processRequestBody = async (req, res, next) => {
  try {
    // 构建请求体
    const body = {
      "stream": true,
      "incremental_output": true,
      "chat_type": "t2t",
      "model": "qwen3-235b-a22b",
      "messages": [],
      "session_id": generateUUID(),
      "id": generateUUID(),
      "sub_chat_type": "t2t",
      "chat_mode": "normal"
    }

    // 获取请求体原始数据
    let {
      messages,            // 消息历史
      model,               // 模型
      stream,              // 流式输出
      enable_thinking,     // 是否启用思考
      thinking_budget,      // 思考预算
      size,                  //图片尺寸
      tools,                // 工具列表（OpenAI function calling）
      tool_choice,          // 工具调用控制
      max_tokens,           // 最大输出 token 数（OpenAI 兼容）
      max_completion_tokens,// 最大补全 token 数（OpenAI 新字段）
      temperature,
      top_p,
      presence_penalty,
      frequency_penalty
    } = req.body

    // 处理 stream 参数
    if (stream === true || stream === 'true') {
      body.stream = true
    } else {
      body.stream = false
    }

    // 处理 chat_type 参数 : 聊天类型
    body.chat_type = isChatType(model)

    req.enable_web_search = body.chat_type === 'search' ? true : false

    // 处理 model 参数 : 模型
    body.model = await parserModel(model)

    // 处理 tools 参数 : 通过提示词为网页版模型注入工具调用能力
    const hasTools = Array.isArray(tools) && tools.length > 0 && body.chat_type === 't2t'
    let preparedMessages = messages
    let toolSystemPrompt = ''
    if (hasTools) {
      toolSystemPrompt = buildToolSystemPrompt(tools, { tool_choice })
      // 仅折叠 assistant.tool_calls / role=tool 历史，不在此插入 system 消息，
      // 避免被下游 parserMessages 折叠成 "system:<提示词>;user:..." 干扰模型理解。
      preparedMessages = foldToolMessages(messages || [])
      req.has_tools = true
      req.tool_choice = tool_choice || 'auto'
    } else {
      req.has_tools = false
    }

    // 处理 messages 参数 : 消息历史
    body.messages = await parserMessages(preparedMessages, isThinkingEnabled(model, enable_thinking, thinking_budget), body.chat_type)

    // 工具提示词在 parserMessages 折叠完成后，作为前缀拼接到最终用户消息内容上，
    // 这样既不会被角色前缀污染，也能让模型在每一轮都看到完整工具说明。
    if (hasTools && toolSystemPrompt && Array.isArray(body.messages) && body.messages.length > 0) {
      const last = body.messages[body.messages.length - 1]
      if (typeof last.content === 'string') {
        last.content = `${toolSystemPrompt}\n\n${last.content}`
      } else if (Array.isArray(last.content)) {
        const textIdx = last.content.findIndex(c => c?.type === 'text')
        if (textIdx >= 0) {
          last.content[textIdx].text = `${toolSystemPrompt}\n\n${last.content[textIdx].text || ''}`
        } else {
          last.content.unshift({
            type: 'text',
            text: toolSystemPrompt,
            chat_type: 't2t',
            feature_config: { output_schema: 'phase', thinking_enabled: false }
          })
        }
      }
    }
    
    // 处理 enable_thinking 参数 : 是否启用思考
    req.enable_thinking = isThinkingEnabled(model, enable_thinking, thinking_budget).thinking_enabled
    
    // 处理 sub_chat_type 参数 : 子聊天类型
    body.sub_chat_type = body.chat_type

    // 处理图片尺寸
    if (size) {
      body.size = size
    }

    // 透传 OpenAI 兼容的生成控制参数到上游 (max_tokens / temperature / top_p / penalties)
    const effectiveMaxTokens = max_completion_tokens ?? max_tokens
    if (Number.isFinite(Number(effectiveMaxTokens)) && Number(effectiveMaxTokens) > 0) {
      body.max_tokens = Number(effectiveMaxTokens)
    }
    if (Number.isFinite(Number(temperature))) body.temperature = Number(temperature)
    if (Number.isFinite(Number(top_p))) body.top_p = Number(top_p)
    if (Number.isFinite(Number(presence_penalty))) body.presence_penalty = Number(presence_penalty)
    if (Number.isFinite(Number(frequency_penalty))) body.frequency_penalty = Number(frequency_penalty)

    // 处理请求体,将body赋值给req.body
    req.body = body

    next()
  } catch (e) {
    logger.error('处理请求体时发生错误', 'MIDDLEWARE', '', e)
    res.status(500)
      .json({
        status: 500,
        message: "在处理请求体时发生错误 ~ ~ ~"
      })
  }
}

module.exports = {
  processRequestBody
}
