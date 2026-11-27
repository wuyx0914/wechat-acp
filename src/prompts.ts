/**
 * Prompt templates for the on-demand bridge commands that delegate to
 * the agent (`/acp-weather`, `/acp-repos`). Each mirrors the matching
 * Hermes daily cron job so the manual command produces the same report
 * on request. Prompts must be self-contained: the agent has no chat
 * context, so everything it needs is spelled out here.
 */

export const WEATHER_PROMPT = (city: string): string => `请播报${city}今日天气、黄历和农历信息，全部用中文输出。这是用户在微信里主动查询的，步骤：

1. **天气**：查询${city}今日天气（可用 web 工具抓取 https://wttr.in/${encodeURIComponent(city)}?format=j1 或 https://wttr.in/${encodeURIComponent(city)}?lang=zh ，也可用 web 搜索"${city}天气 今天"交叉验证）。至少包含：当前气温、今日最高/最低温、天气现象（晴/雨/多云等）、降水概率、风力、湿度；如有空气质量一并给出。
2. **建议**：根据天气给出 2-4 条接地气的实用建议（穿衣、是否带伞、防晒、通风、户外活动/晨练是否合适等）。建议要具体，不要套话。
3. **黄历/农历**：查询今天的农历日期（如"农历七月十五"）、星期、干支年月日、生肖，以及黄历的宜/忌（可用 web 搜索"今日黄历 宜 忌"或抓取黄历网站）。

输出格式：紧凑的 Markdown，分「天气」「建议」「今日黄历」三节，开头一行写明日期。直接信息密度高，不要寒暄。如果某个数据源失败，换一个源重试；全部失败则简短说明。`;

/**
 * Build the GitHub trending prompt around the scraper's JSON output.
 * The script already de-duplicates against previously pushed repos, so
 * the agent must not fetch anything itself.
 */
export const REPOS_PROMPT = (scriptOutput: string, scriptError?: string): string => {
  const header = `这是「GitHub 每日热门仓库探索」任务，用户在微信里主动查询。脚本 github_trending_top100.py 已自动运行，其 stdout（JSON）附在下方，你不需要再抓取任何网页。

请根据 JSON 中的 picked 数组（本次的 10 个仓库，已过滤历史推送、已保存记录），写一份中文日报，直接作为你的最终回复输出（会送达微信）。

格式要求：
- 标题：🚀 GitHub 今日热门 Top10（日期）
- 每个仓库一条：序号 + \`owner/repo\`（粗体）+ 语言 + ⭐star 数（有 stars_today 就附「今日+N」）+ 一句话中文点评（基于 description，没 description 就根据仓库名/语言推测）
- 结尾一行统计：今日抓取 X 个 / 过滤已推送 Y 个 / 记录库共 Z 条（半年自动过期）
- 语气轻松专业，不要寒暄，不要输出 JSON 原文
- 如果 picked 为空（今天没有新仓库），说一句「今日无新上榜仓库，榜单与近期推送重复」即可
- 如果 JSON 的 errors 非空但 picked 不为空，正常推送，但在结尾加一行 ⚠️ 注明抓取警告
- 如果 picked 为空且 errors 非空，输出「⚠️ 今日抓取失败」+ 错误摘要，不要编造仓库`;
  if (scriptError) {
    return `${header}

⚠️ 抓取脚本执行失败，无法获得仓库数据。请只回复一句：「⚠️ 今日抓取失败：${scriptError}」，不要编造仓库。`;
  }
  return `${header}

<github_trending_output>
${scriptOutput}
</github_trending_output>`;
};
