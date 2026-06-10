const axios = require('axios')
const accountManager = require('../utils/account.js')
const { getSsxmodItna, getSsxmodItna2, getCookieHeader } = require('../utils/ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../utils/proxy-helper')

let cachedModels = null
let fetchPromise = null

const getLatestModels = async (force = false) => {
    // 如果有缓存且不强制刷新，直接返回
    if (cachedModels && !force) {
        return cachedModels
    }

    // 如果正在获取，返回当前的 Promise
    if (fetchPromise) {
        return fetchPromise
    }

    const chatBaseUrl = getChatBaseUrl()
    // 一次取出账户对象，token 与 proxy 走同一个账号，避免 round-robin 错位
    const account = accountManager.getAccount()
    const proxyAgent = getProxyAgent(account)

    const requestConfig = {
        headers: {
            'Authorization': `Bearer ${account ? account.token : ''}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': getCookieHeader(account)
        }
    }

    // 添加代理配置
    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }

    fetchPromise = axios.get(`${chatBaseUrl}/api/models`, requestConfig).then(response => {
        // console.log(response)
        cachedModels = response.data.data
        fetchPromise = null
        return cachedModels
    }).catch(error => {
        console.error('Error fetching latest models:', error)
        fetchPromise = null
        return []
    })

    return fetchPromise
}

/**
 * 根据聊天类型获取默认模型
 * @param {string} chatType - 聊天类型
 * @returns {Promise<string|null>} 默认模型 ID
 */
const getDefaultModelByChatType = async (chatType) => {
    const models = await getLatestModels()

    const matchedModel = models.find(model => model?.info?.meta?.chat_type?.includes(chatType))
    return matchedModel?.id || null
}

module.exports = {
    getLatestModels,
    getDefaultModelByChatType
}
