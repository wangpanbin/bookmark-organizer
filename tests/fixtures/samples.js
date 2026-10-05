/**
 * 预置样本集：模拟一个中文开发者真实会收藏的书签。
 * 用途是「规则命中率 ≥70%」这道自动闸门。
 * ⚠️ 这是闸门的输入，改它等于改闸门 —— 扩样本要一并复核期望值。
 */

/** @type {Array<{url: string, title: string, expect?: string|null}>}
 *  expect 显式写死的条目：必须分类到该路径。留空表示只统计命中率。 */
export const SAMPLE_BOOKMARKS = [
  // 开发与技术
  { url: 'https://github.com/vuejs/core', title: 'vuejs/core', expect: '开发与技术/代码托管' },
  { url: 'https://gitee.com/openharmony', title: 'OpenHarmony', expect: '开发与技术/代码托管' },
  { url: 'https://reactjs.org/docs/hooks-intro.html', title: 'Hooks', expect: '开发与技术/前端' },
  { url: 'https://cn.vuejs.org/guide/', title: 'Vue 3 文档', expect: '开发与技术/前端' },
  { url: 'https://vitejs.dev/config/', title: 'Vite 配置', expect: '开发与技术/前端' },
  { url: 'https://spring.io/projects/spring-boot', title: 'Spring Boot', expect: '开发与技术/后端' },
  { url: 'https://mybatis-plus.baomidou.cn/', title: 'MyBatis-Plus', expect: '开发与技术/后端' },
  { url: 'https://fastapi.tiangolo.com/zh/', title: 'FastAPI', expect: '开发与技术/后端' },
  { url: 'https://dev.mysql.com/doc/refman/8.0/en/', title: 'MySQL 8.0 手册', expect: '开发与技术/数据库' },
  { url: 'https://redis.io/docs/latest/', title: 'Redis 文档', expect: '开发与技术/数据库' },
  { url: 'https://www.postgresql.org/docs/', title: 'PostgreSQL Docs', expect: '开发与技术/数据库' },
  { url: 'https://docs.docker.com/get-started/', title: 'Docker Get Started', expect: '开发与技术/DevOps' },
  { url: 'https://kubernetes.io/zh-cn/docs/home/', title: 'K8s 文档', expect: '开发与技术/DevOps' },
  { url: 'https://www.jenkins.io/doc/', title: 'Jenkins', expect: '开发与技术/DevOps' },
  { url: 'https://developer.mozilla.org/zh-CN/docs/Web', title: 'MDN Web 文档' },
  { url: 'https://caniuse.com/', title: 'Can I Use' },

  // AI 与大模型
  { url: 'https://platform.openai.com/docs', title: 'OpenAI API', expect: 'AI 与大模型/模型与 API' },
  { url: 'https://help.aliyun.com/zh/model-studio/', title: '百炼模型服务' },
  { url: 'https://huggingface.co/Qwen', title: 'Qwen on HF', expect: 'AI 与大模型/模型与 API' },
  { url: 'https://chatgpt.com/', title: 'ChatGPT', expect: 'AI 与大模型/AI 工具' },
  { url: 'https://claude.ai/chat', title: 'Claude', expect: 'AI 与大模型/AI 工具' },
  { url: 'https://gemini.google.com/app', title: 'Gemini', expect: 'AI 与大模型/AI 工具' },
  { url: 'https://www.doubao.com/chat/', title: '豆包' },
  { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need', expect: 'AI 与大模型/论文与研究' },
  { url: 'https://arxiv.org/abs/2405.15722', title: 'vLLM', expect: 'AI 与大模型/论文与研究' },

  // 效率工具
  { url: 'https://www.notion.so/my-workspace', title: '我的 Notion', expect: '效率工具/笔记与知识' },
  { url: 'https://obsidian.md/', title: 'Obsidian', expect: '效率工具/笔记与知识' },
  { url: 'https://app.todoist.com/app/today', title: '今日待办', expect: '效率工具/任务管理' },
  { url: 'https://dida365.com/', title: '滴答清单', expect: '效率工具/任务管理' },
  { url: 'https://docs.google.com/spreadsheets/d/1x/edit', title: '我的表格', expect: '效率工具/在线文档' },
  { url: 'https://docs.qq.com/sheet/QQ123', title: '腾讯文档', expect: '效率工具/在线文档' },
  { url: 'https://discord.com/channels/@me', title: 'Discord' },

  // 学习资料
  { url: 'https://leetcode.cn/problemset/', title: '力扣', expect: '学习资料/编程学习' },
  { url: 'https://www.nowcoder.com/', title: '牛客网', expect: '学习资料/编程学习' },
  { url: 'https://time.geekbang.org/course-list', title: '极客时间课程', expect: '学习资料/技术课程' },
  { url: 'https://weread.qq.com/', title: '微信读书', expect: '学习资料/电子书' },
  { url: 'https://www.runoob.com/', title: '菜鸟教程', expect: '学习资料/编程学习' },
  { url: 'https://codeforces.com/', title: 'Codeforces' },

  // 设计资源
  { url: 'https://dribbble.com/shots/popular', title: 'Dribbble', expect: '设计资源/UI 设计' },
  { url: 'https://www.figma.com/files/recents', title: 'Figma', expect: '设计资源/设计工具' },
  { url: 'https://www.iconfont.cn/collections/index', title: 'iconfont', expect: '设计资源/素材与图标' },
  { url: 'https://coolors.co/palettes/trending', title: '配色', expect: '设计资源/配色与灵感' },
  { url: 'https://www.zcool.cn/', title: '站酷' },

  // 工作办公
  { url: 'https://www.feishu.cn/messenger/', title: '飞书', expect: '工作办公/企业协作' },
  { url: 'https://mail.qq.com/', title: 'QQ 邮箱', expect: '工作办公/邮箱' },
  { url: 'https://mail.163.com/', title: '网易邮箱', expect: '工作办公/邮箱' },
  { url: 'https://www.zhipin.com/', title: 'BOSS 直聘', expect: '工作办公/行业资讯' },
  { url: 'https://www.tianyancha.com/', title: '天眼查' },

  // 新闻资讯
  { url: 'https://www.ithome.com/', title: 'IT之家', expect: '新闻资讯/科技媒体' },
  { url: 'https://www.cnbeta.com.tw/', title: 'cnBeta' },
  { url: 'https://36kr.com/', title: '36氪', expect: '新闻资讯/科技媒体' },
  { url: 'https://www.jiqizhixin.com/', title: '机器之心', expect: '新闻资讯/科技媒体' },
  { url: 'https://www.thepaper.cn/', title: '澎湃新闻' },
  { url: 'https://xueqiu.com/', title: '雪球' },

  // 影音娱乐
  { url: 'https://www.bilibili.com/', title: '哔哩哔哩', expect: '影音娱乐/视频' },
  { url: 'https://www.youtube.com/watch?v=abc', title: 'YouTube', expect: '影音娱乐/视频' },
  { url: 'https://music.163.com/', title: '网易云音乐', expect: '影音娱乐/音乐' },
  { url: 'https://store.steampowered.com/app/730/CounterStrike_2/', title: 'CS2' },
  { url: 'https://www.pixiv.net/', title: 'pixiv', expect: '影音娱乐/图像与动漫' },

  // 购物消费
  { url: 'https://www.taobao.com/', title: '淘宝', expect: '购物消费/电商' },
  { url: 'https://item.jd.com/100012043978.html', title: '京东商品' },
  { url: 'https://www.smzdm.com/', title: '什么值得买', expect: '购物消费/比价' },
  { url: 'https://www.meituan.com/', title: '美团', expect: '购物消费/生活服务' },
  { url: 'https://www.12306.cn/index/', title: '12306' },

  // 长尾：这些大概率命中不了，用于把命中率压到真实水平（防止闸门虚高）
  { url: 'https://internal.corp.example.com/wiki/abc123', title: '内部Wiki文档' },
  { url: 'https://my-private-notes.pages.dev/project-a', title: '我的小项目' },
  { url: 'https://example.com/', title: '示例站点' },
  { url: 'https://unknown-vendor-cn.net/download', title: '某下载站' },
  { url: 'https://myblog.xyz/2024/01/hello-world', title: '我的博客文章' },
  { url: 'https://shop.local-store.test/cart', title: '本地小店' },
  { url: 'https://forum.example.org/thread/9981', title: '论坛帖子' },
  { url: 'https://docs-internal.company.dev/architecture', title: '架构文档' },
];

/** 命中率闸门阈值（初版放宽；跑三轮真实数据后收紧到 0.8） */
export const HIT_RATE_THRESHOLD = 0.7;
