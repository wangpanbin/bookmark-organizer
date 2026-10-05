/**
 * 预置规则词典。
 * ⚠️ 纯数据模块：不得 import chrome API。
 *
 * ═══ 维护铁律 ═══
 * 1. 所有规则一律写满 5 个位置参数，顺序固定：
 *      R(to, domains, pathWords, titleWords, domainSuffixes)
 *    不允许省略中间参数。早先本文件混用过 4 参数与 5 参数两种布局，
 *    一次签名调整就让整本词典的 pathWords / titleWords 整体错位
 *    （技术文档的 pathWords 消失、arxiv.org 落进 pathWords），
 *    而现象只表现为「部分标题匹配不到」，极易误判成规则本身写得不好。
 * 2. `to` 必须是 taxonomy.js 里的合法路径。
 * 3. `domains` / `domainSuffixes` 里每一项都必须是合法主机名。
 * 4. `pathWords` 每一项必须以 `/` 开头。
 * 5. 中文品牌名一律放 `titleWords`，绝不放 `domains` / `domainSuffixes`。
 * 6. 一个域名只能出现在一条规则里。匹配是「首个命中即返回」，
 *    重复归属等于后面全是死条目，且极易悄悄归错类。
 *    ⚠️ 注意 `time.geekbang.org` 与 `geekbang.org` 在去重校验里算两个不同字符串，
 *       但匹配时前者会先命中 —— 归到同一处时必须显式列出所有子域。
 * 以上 1-6 全部由 tests/unit/dict.test.js 自动断言，改坏了会红。
 *
 * 匹配语义：domains 精确；domainSuffixes 按点边界（`a.github.com` 命中，
 * `notgithub.com` 不命中）；pathWords 匹配 pathname+search；titleWords 匹配标题。
 */

const R = (to, domains = [], pathWords = [], titleWords = [], domainSuffixes = []) => ({
  to,
  domains,
  domainSuffixes,
  pathWords,
  titleWords,
});

export const DEFAULT_RULES = [
  // ───────────────────────── 开发与技术 ─────────────────────────
  R('开发与技术/代码托管', [
    'github.com', 'gist.github.com', 'gitlab.com', 'gitee.com', 'bitbucket.org',
    'codeberg.org', 'gitcode.com', 'sourceforge.net', 'npmjs.com', 'pypi.org',
    'crates.io', 'rubygems.org', 'packagist.org', 'jsdelivr.com', 'unpkg.com',
    'cdnjs.com', 'mirrors.aliyun.com', 'mirrors.tuna.tsinghua.edu.cn',
    'repo.huaweicloud.com', 'conan.io', 'hex.pm', 'pub.dev', 'nuget.org',
  ], [], ['github', 'gitlab', 'gitee', '开源仓库', '镜像站', '包管理']),
  R('开发与技术/前端', [
    'reactjs.org', 'vuejs.org', 'angular.io', 'svelte.dev', 'solidjs.com',
    'nextjs.org', 'nuxt.com', 'remix.run', 'astro.build', 'vitejs.dev',
    'webpack.js.org', 'rollupjs.org', 'esbuild.github.io', 'babeljs.io',
    'tailwindcss.com', 'tailwindcss.cn', 'element-plus.org', 'ant.design',
    'mui.com', 'chakra-ui.com', 'storybook.js.org', 'redux.js.org',
    'pinia.vuejs.org', 'jquery.com', 'threejs.org', 'd3js.org', 'codepen.io',
    'codesandbox.io', 'jsfiddle.net', 'caniuse.com', 'sass-lang.com',
    'postcss.org', 'lesscss.org', 'stylus-lang.com', 'reactrouter.com',
    'vitepress.dev', 'docusaurus.io', 'umijs.org', 'electronjs.org',
  ], [], ['css 框架', '前端框架', '组件库', '打包工具', '脚手架'],
    ['vuejs.org', 'reactjs.org', 'svelte.dev', 'nuxt.com', 'nextjs.org', 'angular.io', 'solidjs.com']),
  R('开发与技术/后端', [
    'spring.io', 'docs.spring.io', 'springboot.io', 'baeldung.com', 'mybatis.org',
    'mybatis-plus.baomidou.cn', 'hibernate.org', 'jhipster.tech', 'djangoproject.com',
    'docs.djangoproject.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com',
    'expressjs.com', 'nestjs.com', 'gin-gonic.com', 'go.dev', 'golang.org',
    'nodejs.org', 'laravel.com', 'symfony.com', 'rubyonrails.org', 'php.net',
    'dotnet.microsoft.com', 'rabbitmq.com', 'kafka.apache.org', 'grpc.io',
    'protobuf.dev', 'socket.io', 'jwt.io', 'jsonwebtoken.io', 'auth0.com',
    'keycloak.org', 'quarkus.io', 'microservices.io', 'elastic.co',
  ], [], ['后端框架', '微服务', 'api 网关', 'orm 框架', '消息队列']),
  R('开发与技术/数据库', [
    'mysql.com', 'dev.mysql.com', 'postgresql.org', 'sqlite.org', 'mongodb.com',
    'redis.io', 'clickhouse.com', 'clickhouse.tech', 'mariadb.org', 'dbeaver.io',
    'navicat.com', 'sequelize.org', 'prisma.io', 'knexjs.org', 'typeorm.io',
    'sqlalchemy.org', 'gorm.io', 'planetscale.com', 'cockroachlabs.com',
    'h2database.com', 'duckdb.org', 'doris.apache.org', 'starrocks.io',
    'neo4j.com', 'influxdata.com', 'questdb.com', 'tidb.com', 'opengauss.org',
  ], ['/sql', '/database', '/db'], ['数据库客户端', '时序数据库', '图数据库']),
  R('开发与技术/DevOps', [
    'docker.com', 'docs.docker.com', 'kubernetes.io', 'k8s.io', 'helm.sh',
    'jenkins.io', 'travis-ci.org', 'circleci.com', 'ansible.com', 'puppet.com',
    'chef.io', 'terraform.io', 'developer.hashicorp.com', 'vaultproject.io',
    'consul.io', 'nomadproject.io', 'grafana.com', 'prometheus.io', 'sentry.io',
    'datadoghq.com', 'newrelic.com', 'nginx.org', 'apache.org', 'caddyweb-server.com',
    'cloudflare.com', 'alibabacloud.com', 'tencentcloud.com', 'huaweicloud.com',
    'aws.amazon.com', 'azure.microsoft.com', 'cloud.google.com', 'istio.io',
    'envoyproxy.io', 'traefik.io', 'keepalived.org', 'zabbix.com', 'grafana.org',
    'rancher.com', 'argoproj.org', 'fluxcd.io',
  ], [], ['devops', '运维', 'ci/cd', '持续集成', '监控', '云服务', '容器', '服务网格']),
  R('开发与技术/技术文档', [
    'w3schools.com', 'devdocs.io', 'readthedocs.io', 'docs.rs', 'docs.python.org',
    'docs.oracle.com', 'tc39.es', 'whatwg.org', 'w3.org', 'developer.android.com',
    'developer.apple.com', 'web.dev', 'developer.chrome.com',
    'developer.mozilla.org', 'typescriptlang.org', 'pyright.dev', 'eslint.org',
    'prettier.io',
  ], ['/docs', '/doc', '/reference', '/api-docs'], ['官方文档', 'api 参考', '规范', 'mdn']),

  // ───────────────────────── AI 与大模型 ─────────────────────────
  R('AI 与大模型/模型与 API', [
    'openai.com', 'platform.openai.com', 'api.openai.com', 'anthropic.com',
    'console.anthropic.com', 'ai.google.dev', 'deepseek.com', 'platform.deepseek.com',
    'api.deepseek.com', 'moonshot.cn', 'platform.moonshot.cn', 'qwen.ai',
    'bailian.console.aliyun.com', 'dashscope.aliyuncs.com', 'bigmodel.cn',
    'open.bigmodel.cn', 'siliconflow.cn', 'modelscope.cn', 'cohere.com',
    'mistral.ai', 'ollama.com', 'together.ai', 'groq.com', 'fireworks.ai',
    'replicate.com', 'langchain.com', 'langchain.dev', 'llamaindex.ai',
    'openrouter.ai', 'x.ai', 'perplexity.ai', 'ai.googleblog.com', 'pytorch.org',
    'tensorflow.org', 'huggingface.co', 'kaggle.com', 'colab.research.google.com',
    'jax.readthedocs.io', 'vllm.ai', 'lmstudio.ai',
  ], [], ['api 文档', '模型列表', 'sdk', '推理框架', '大模型', '模型', '机器学习'],
    ['openai.com', 'anthropic.com', 'deepseek.com', 'huggingface.co', 'modelscope.cn']),
  R('AI 与大模型/提示词工程', [
    'promptingguide.ai', 'dair-ai.github.io', 'learnprompting.org',
    'awesome-chatgpt-prompts.com', 'prompts.chat', 'flowgpt.com', 'promptbase.com',
  ], ['/prompt'], ['提示词', 'prompt engineering', '咒语', 'prompt']),
  R('AI 与大模型/AI 工具', [
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
    'bard.google.com', 'copilot.microsoft.com', 'copilot.bing.com', 'poe.com',
    'you.com', 'phind.it', 'xinghuo.xfyun.cn', 'yiyan.baidu.com', 'doubao.com',
    'chat.deepseek.com', 'kimi.moonshot.cn', 'tongyi.aliyun.com', 'chatglm.cn',
    'yuanbao.tencent.com', 'cursor.com', 'windsurf.com',
    'midjourney.com', 'leonardo.ai', 'runwayml.com', 'elevenlabs.io', 'suno.com',
  ], [], ['ai 助手', '智能体', '豆包', 'kimi', '元宝', '文心', '星火', '绘画 ai']),
  R('AI 与大模型/论文与研究', [
    'arxiv.org', 'paperswithcode.com', 'semanticscholar.org', 'research.google',
    'distill.pub', 'baulab.info', 'papers.co', 'openreview.net', 'aclanthology.org',
    'cnki.net', 'wanfangdata.com.cn', 'connectedpapers.com', 'scholar.google.com',
  ], ['/abs/', '/pdf/'], ['论文', 'arxiv', '综述', '学术']),

  // ───────────────────────── 效率工具 ─────────────────────────
  R('效率工具/笔记与知识', [
    'notion.so', 'notion.site', 'obsidian.md', 'roamresearch.com', 'logseq.com',
    'workflowy.com', 'evernote.com', 'siyuan-note.com', 'appflowy.io', 'anytype.io',
    'flomo.io', 'wolai.com', 'memos.app', 'bear.app', 'tana.inc', 'mem.ai',
    'zettelkasten.de', 'triliumnext.com', 'joplinapp.org', 'simplenote.com',
    'craft.do', 'heptabase.com', 'mymind.com',
  ], ['/notes', '/note'], ['笔记', '双链', '知识管理', 'evernote', '印象笔记']),
  R('效率工具/任务管理', [
    'todoist.com', 'ticktick.com', 'dida365.com', 'trello.com', 'asana.com',
    'monday.com', 'clickup.com', 'linear.app', 'height.app', 'thingsapp.com',
    'omnifocus.com', 'tada.house', 'habitica.net', 'todo.txt', 'twos.net',
    'efficient.cc', 'wunderlist.com', 'any.do', 'nozbe.com', 'todoizapp.com',
  ], ['/tasks', '/todo'], ['待办', '任务管理', 'todo', '项目管理', '习惯打卡', '滴答清单']),
  R('效率工具/在线文档', [
    'docs.google.com', 'drive.google.com', 'office.com', 'onedrive.live.com',
    'dropbox.com', 'docs.qq.com', 'wps.cn', 'docs.aliyun.com', 'pastebin.com',
    'carbon.now.sh', 'excalidraw.com',
  ], ['/document', '/drive'], ['云文档', '在线文档', '在线表格', '腾讯文档', '语雀', '石墨', '白板']),
  R('效率工具/协作工具', [
    'discord.com', 'miro.com', 'zapier.com', 'ifttt.com', 'mermaid.live',
    'metabase.com', 'supabase.com',
  ], [], ['协作', '团队沟通', '自动化', 'discord', 'slack']),

  // ───────────────────────── 学习资料 ─────────────────────────
  R('学习资料/编程学习', [
    'leetcode.cn', 'leetcode.com', 'nowcoder.com', 'imooc.com', 'itcast.cn',
    'liaoxuefeng.com', 'w3cschool.com', 'freecodecamp.org', 'codecademy.com',
    'exercism.org', 'khanacademy.org', 'hackerrank.com', 'codewars.com',
    'csdn.net', 'juejin.cn', 'cnblogs.com', 'runoob.com', 'oschina.net',
    'geekslab.org', 'acwing.com', 'luogu.com.cn', 'acm.org',
    'roadmap.sh', 'sourcemaking.com', 'adoptium.net',
  ], ['/tutorial', '/learn'], ['教程', '入门', '学习路线', '算法题', '掘金', '博客园', '思否', '面试', '牛客', '力扣', '菜鸟教程', '廖雪峰', '传智播客']),
  R('学习资料/技术课程', [
    'coursera.org', 'edx.org', 'udemy.com', 'udacity.com', 'icourse163.org',
    'study.163.com', 'geekbang.org', 'dedao.cn', 'xuetangx.com', 'chaoshan.com',
    'time.geekbang.org',
  ], ['/course'], ['课程', '网课', '公开课', '慕课网', '极客时间', '网易云课堂', '中国大学', 'mooc', '得到'],
    ['geekbang.org']),
  R('学习资料/电子书', [
    'weread.qq.com', 'ituring.com.cn', 'gutenberg.org', 'archive.org',
    'ucdrs.superlib.net', 'readmoo.com', 'book.douban.com', 'openstax.org',
    'standardebooks.org', 'z-lib.org', 'annas-archive.org',
  ], ['/books', '/book/'], ['电子书', '读书', '图灵', '微信阅读', 'kindle', '书']),
  R('学习资料/考试认证', [
    'codeforces.com', 'atcoder.jp', 'topcoder.com', 'xctf.org.cn',
    'buuoj.cn', 'ctf-wiki.org', 'seebug.org', 'cisco.com',
    'it-cert.cn', 'aliyun.com', 'e.huawei.com',
  ], ['/certificate', '/certification'], ['认证', '考试', '面试题', 'ctf', '蓝桥杯']),

  // ───────────────────────── 设计资源 ─────────────────────────
  R('设计资源/UI 设计', [
    'dribbble.com', 'behance.net', 'framer.com', 'awwwards.com', 'thefader.com',
    'siteinspire.com', 'land-book.com', 'refero.design', 'mobbin.com',
    'zcool.com.cn', 'uisdc.com', 'shejichina.com', 'gtn9.com', 'nngroup.com',
    'lawsofux.com', 'refactoringui.com', 'alistapart.com',
  ], ['/gallery', '/showcase'], ['ui 设计', '界面设计', '设计稿', '设计规范', '用户体验', '站酷', '优设', '花瓣']),
  R('设计资源/素材与图标', [
    'iconfont.cn', 'icons8.com', 'flaticon.com', 'fontawesome.com', 'material.io',
    'thenounproject.com', 'undraw.co', 'svgrepo.com', 'remove.bg',
    'freepik.com', 'pngwing.com', 'lovepik.com', '58pic.com', '588ku.com',
    'ibaotu.com', '699pic.com', '51yuansu.com', 'tinypng.com', 'compresspng.com',
    'haikei.com', 'heroicons.com', 'phosphoricons.com', 'lucide.dev', 'tabler.io',
    'iconmonstr.com', 'iconpark.oceanengine.com', 'uicons.io', 'rawpixel.com',
    'picsum.photos', 'placehold.co', 'placekitten.com', 'source.unsplash.com',
  ], [], ['图标', '素材', '免抠图', '抠图', '占位图', '图片压缩', '图库', '千图']),
  R('设计资源/配色与灵感', [
    'coolors.co', 'colorhunt.co', 'color.adobe.com', 'pigments.app', 'colorbox.io',
    'clrs.cc', 'flatuicolors.com', 'colorbrewer2.org', 'happyhue.co', 'khroma.co',
    'uigradients.com', 'gradientmagic.com', 'igee.cn', 'mycolor.space',
    'lospec.com',
  ], ['/palette', '/color'], ['配色', '色板', '渐变', '色彩', 'color']),
  R('设计资源/设计工具', [
    'figma.com', 'sketch.com', 'canva.com', 'adobe.com', 'photopea.com',
    'pixlr.com', 'lanhuapp.com', 'mokeding.com', 'modao.cc', 'axure.com',
    'xd.adobe.com', 'vectormagic.com', 'coolbackgrounds.com', 'recolor.io',
    'cloudconvert.com', 'upscale.com',
  ], [], ['设计工具', '原型', 'psd', '抠图工具', '蓝湖', '墨刀', 'figma']),

  // ───────────────────────── 工作办公 ─────────────────────────
  R('工作办公/企业协作', [
    'feishu.cn', 'larksuite.com', 'dingtalk.com', 'wecom.qq.com', 'zoom.us',
    'teams.microsoft.com', 'slack.com', 'atlassian.net', 'jira.atlassian.com',
    'confluence.atlassian.com', 'basecamp.com', 'yuque.com', 'shimo.im',
    'worktile.com', 'tower.im', 'teambition.com', 'pingcode.com',
    'meeting.tencent.com', 'voovmeeting.com', 'wemeet.cctv.com',
  ], [], ['企业微信', '飞书', '钉钉', '会议', '项目管理', '语雀', '石墨', 'jira', 'confluence']),
  R('工作办公/邮箱', [
    'gmail.com', 'mail.google.com', 'outlook.com', 'outlook.live.com', 'protonmail.com',
    'mail.qq.com', 'mail.163.com', 'mail.foxmail.com', 'mail.yahoo.com',
    'mail.sina.com', 'mail.china.com', 'superhuman.com', 'front.com', 'hey.com',
    'mailchimp.com', 'sendgrid.com', 'smtp2go.com', 'mailtrap.io', 'zoho.com',
  ], [], ['邮箱', '邮件', '邮件营销', 'outlook', 'gmail']),
  R('工作办公/财务与报销', [
    'alipay.com', 'pay.weixin.qq.com', 'chinatax.gov.cn', '12366.chinatax.gov.cn',
    'cmbchina.com', 'icbc.com.cn', 'boc.cn', 'ccb.com', 'bankcomm.com',
    'abchina.com', 'psbc.com', 'pingan.com', 'citicbank.com', 'cebbank.com',
    'fenbeitong.com', 'kingdee.com', 'yonyou.com', 'jeecg.com', '51shibo.com',
    'si.12333.gov.cn', 'chinahr.com', 'kuaibiao.com', 'huiyiye.com', 'mbalib.com',
  ], [], ['报销', '发票', '税务', '社保', '公积金', '银行', '费控', '金蝶', '用友', '支付宝']),
  R('工作办公/行业资讯', [
    'maimai.cn', 'zhipin.com', 'zhaopin.com', '51job.com', 'liepin.com',
    'lagou.com', 'linkedin.com', 'kanzhun.com', 'tianyancha.com', 'qcc.com',
    'aiqicha.baidu.com',
  ], [], ['招聘', '求职', '职场', '行业报告', '工商信息', '天眼查', 'boss直聘', '智联', '猎聘', '领英', '脉脉']),

  // ───────────────────────── 新闻资讯 ─────────────────────────
  R('新闻资讯/科技媒体', [
    'ithome.com', 'cnbeta.com.tw', 'cnbeta.com', 'solidot.org', 'osnews.net',
    'techweb.com.cn', 'yesky.com', 'cnmo.com', 'qbitai.com', 'jiqizhixin.com',
    '36kr.com', 'huxiu.com', 'geekpark.net', 'tmtpost.com', 'ifanr.com',
    'pingwest.com', 'sspai.com', 'leiphone.com', 'infoq.cn', '51cto.com',
    'segmentfault.com', 'tech.qq.com', 'diandigital.com', 'techcrunch.com',
    'theverge.com', 'arstechnica.com', 'wired.com', 'engadget.com', 'hackaday.com',
    'slashdot.org', 'lwn.net', 'phoronix.com', 'ithome.net', 'chiphell.com',
  ], [], ['科技媒体', '科技新闻', '虎嗅', '钛媒体', '极客公园', '爱范儿', '少数派', '量子位', '机器之心', '数字尾巴', 'it 之家', 'cnbeta', 'solidot']),
  R('新闻资讯/综合新闻', [
    'news.sina.com.cn', 'news.qq.com', 'news.163.com', 'ifeng.com', 'people.com.cn',
    'xinhuanet.com', 'cctv.com', 'chinanews.com', 'thepaper.cn', 'zhihu.com',
    'toutiao.com', 'sohu.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
    'theguardian.com', 'reuters.com', 'apnews.com', 'washingtonpost.com', 'zaobao.com',
  ], ['/news'], ['新闻', '资讯', '日报', '早报', '知乎', '澎湃', '新华', '人民网', '央视']),
  R('新闻资讯/财经市场', [
    'eastmoney.com', 'xueqiu.com', '10jqka.com.cn', 'wallstreetcn.com', 'jin10.com',
    'fx678.com', 'hexun.com', 'cnstock.com', 'cninfo.com.cn', 'sse.com.cn',
    'szse.cn', 'csrc.gov.cn', 'pbc.gov.cn', 'stats.gov.cn', 'investing.com',
    'tradingview.com', 'finance.yahoo.com', 'fund.eastmoney.com', 'choice.eastmoney.com',
    'wind.com.cn',
  ], [], ['股票', '基金', '财经', '行情', '财报', '同花顺', '东方财富', '雪球', '华尔街见闻', '金十', '财经新闻']),

  // ───────────────────────── 影音娱乐 ─────────────────────────
  R('影音娱乐/视频', [
    'youtube.com', 'youtu.be', 'youku.com', 'iqiyi.com', 'v.qq.com', 'bilibili.com',
    'netflix.com', 'disneyplus.com', 'hulu.com', 'twitch.tv', 'vimeo.com',
    'dailymotion.com', 'ted.com', 'mgtv.com', 'acfun.cn', 'douyin.com', 'tiktok.com',
    'youtube-nocookie.com', 'nicovideo.jp', 'xtvgo.com', 'tvb.com', 'abema.tv',
    'wetv.vip', 'iq.com', 'player.bilibili.com', 'odysee.com', 'rumble.com',
  ], ['/video', '/watch?v='], ['视频', '追剧', '纪录片', '网课视频', '哔哩哔哩', 'b站', '抖音', '爱奇艺', '优酷', '腾讯视频', 'youtube', 'netflix']),
  R('影音娱乐/音乐', [
    'music.163.com', 'y.qq.com', 'kugou.com', 'kuwo.cn', 'spotify.com',
    'music.apple.com', 'soundcloud.com', 'bandcamp.com', 'tidal.com',
    'deezer.com', 'last.fm', 'pandora.com', 'ultimate-guitar.com', 'songsterr.com',
    '5sing.kugou.com', 'music.douban.com', 'ximalaya.com', 'xiaoyuzhoufm.com',
    'pods.apple.com', 'anchor.fm', 'audiomack.com', 'jiosaas.com',
  ], ['/music', '/song'], ['音乐', '歌单', '播客', '网易云音乐', 'qq音乐', '酷狗', '酷我', '喜马拉雅', '小宇宙', 'spotify']),
  R('影音娱乐/游戏', [
    'steampowered.com', 'store.steampowered.com', 'steamcommunity.com', 'epicgames.com',
    'gog.com', 'battle.net', 'riotgames.com', 'ubisoft.com', 'ea.com', 'minecraft.net',
    'curseforge.com', 'modrinth.com', 'nexusmods.com', 'humblebundle.com', 'itch.io',
    '3dmgame.com', 'gamersky.com', 'gcores.com', 'nga.cn', 'taptap.io', '9game.cn',
    'wiki.biligame.com', 'bahamut.com.tw', 'moegirl.org.cn', 'xbox.com',
    'playstation.com', 'nintendo.com', 'hoyolab.com', 'mihoyo.com', 'op.gg',
    'lol.qq.com', 'steamdb.info',
  ], ['/steam', '/game/'], ['游戏', '攻略', 'mods', 'mod', '开黑', '战绩', 'steam', '原神', '米哈游', '游民星空', '机核']),
  R('影音娱乐/图像与动漫', [
    'pixiv.net', 'danbooru.donmai.us', 'deviantart.com', 'artstation.com',
    'imgur.com', 'flickr.com', '500px.com', 'unsplash.com', 'pexels.com',
    'pinterest.com', 'huaban.com', 'weibo.com', 'anilist.co', 'myanimelist.net',
    'kitsu.io', 'bgm.tv', 'safebooru.org', 'konachan.com', 'wallhaven.cc',
    'mangadex.org', 'webtoons.com', 'instagram.com', 'imgbox.com',
    'zerochan.net', 'konachan.net',
  ], ['/art', '/gallery/'], ['动漫', '二次元', '插画', '壁纸', '画师', '图床', '写真', 'pixiv', 'p站', '微博', '花瓣', '无图']),

  // ───────────────────────── 购物消费 ─────────────────────────
  R('购物消费/电商', [
    'taobao.com', 'tmall.com', 'jd.com', 'pdd.com', '1688.com', 'alibaba.com',
    'aliexpress.com', 'amazon.com', 'amazon.co.jp', 'amazon.de', 'ebay.com',
    'etsy.com', 'shopee.com', 'lazada.com', 'temu.com', 'shein.com', 'wish.com',
    'dangdang.com', 'dewu.com', 'you.163.com', 'miyoushe.com', 'suning.com',
    'gome.com.cn', 'vip.com', 'muji.com.cn', 'muji.com', 'uniqlo.cn', 'zara.com',
  ], ['/shop', '/mall', '/cart', '/product/'], ['购物', '下单', '旗舰店', '海淘', '淘宝', '天猫', '京东', '拼多多', '亚马逊', '小红书', '网易严选']),
  R('购物消费/比价', [
    'smzdm.com', 'manmanbuy.com', 'huihui.com', 'gwdang.com', 'fanli.cn',
    'zhekou.com', 'manmanbuy.cn', 'gwdang.com.cn', 'laodong.com',
  ], ['/price', '/deal'], ['比价', '优惠', '折扣', '值不值得买', '什么值得买', '慢慢买', '购物党', '返利网', '历史价格', '历史价']),
  R('购物消费/数码产品', [
    'zol.com.cn', 'pconline.com.cn', 'pcpop.com', 'nvidia.cn', 'nvidia.com',
    'amd.com', 'intel.cn', 'intel.com', 'asus.com', 'msi.com', 'razer.com',
    'logitech.com', 'seagate.com', 'samsung.com', 'apple.com', 'apple.com.cn',
    'mi.com', 'huawei.com', 'infixadiy.com', 'inno3d.com', 'gainward.com',
    'colorful.cn', 'igames.com.cn',
  ], ['/review', '/spec'], ['显卡', 'cpu', '硬件', '笔记本', '评测', '机械键盘', '中关村在线', '太平洋电脑网']),
  R('购物消费/生活服务', [
    'meituan.com', 'dianping.com', 'eleme.me', '58.com', 'anjuke.com', 'ke.com',
    'lianjia.com', 'ziroom.com', 'ctrip.com', 'qunar.com', 'ly.com', '12306.cn',
    'booking.com', 'airbnb.com', 'trip.com', 'agoda.com', 'mafengwo.cn', 'qyer.com',
    'didi.com', 'ele.me', 'meituan.net', 'gushiwen.cn', 'didiglobal.com',
  ], ['/shop', '/list', '/hotel'], ['外卖', '订酒店', '打车', '门票', '生活服务', '租房', '旅游', '美食', '美团', '大众点评', '携程', '马蜂窝']),
];

export default DEFAULT_RULES;
