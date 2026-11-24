'use strict';

const DAY = 24 * 60 * 60 * 1000;
const SAMPLE_DAY = '2026-01-12';
const EXPECTED_STEPS = ['准备示例场景', '呈现首帧', '打开主菜单', '进入场景'];

function project(repo, title, type, status, summary, progress, portProgress, evidence) {
  return { repo: `demo-workshop/${repo}`, title, type, status, summary, progress, portProgress, evidence };
}

function createFixtures(now) {
  const target = new Date(now + 7 * DAY).toISOString();
  const projects = [
    project('aurora-runner', 'Aurora Runner', 'runner', 'progress',
      '兼容层示例。用测试场景展示从启动到首帧的里程碑。',
      '首帧已在样例场景中标记为完成，主菜单处于部分完成状态。',
      { groundwork: { loader: 1, shaders: 0.75, graphics: 0.8, proven: 0.5 }, gta: { loads: 1, boots: 1, menu: 0.4 },
        works: ['启动流程', '单场景首帧'], blocking: ['菜单输入等待验证'], verification: 'self-reported', assessedAt: SAMPLE_DAY },
      { tested: 'Aurora 样例场景', level: 'self-reported', blocker: '尚未验证菜单交互。' }),
    project('frame-lab', 'Frame Lab', 'runner', 'early',
      '渲染兼容性样例。将准备工作拆成独立进度项。',
      '样例程序已标记为启动，首帧进度暂未更新。',
      { groundwork: { loader: 1, shaders: 0.55, graphics: 0.48, proven: 0.2 }, gta: { loads: 1 },
        works: ['读取场景配置'], blocking: ['渲染画面待验证'], verification: 'unverified' },
      { tested: '离线渲染样例', level: 'unverified' }),
    project('shader-notebook', 'Shader Notebook', 'tool', 'tool',
      '示例工具。记录渲染实验的输入、输出和已知限制。',
      '增加测试记录模板与按版本归档的样例。',
      { groundwork: { shaders: 0.75, graphics: 0.25 }, verification: 'unverified' },
      { tested: '图形测试样例', level: 'unverified' }),
    project('input-garden', 'Input Garden', 'tool', 'tool',
      '示例工具。归档键盘和手柄的交互测试记录。',
      '补充键盘焦点和控制器切换的样例。',
      undefined, { tested: '输入测试样例', level: 'unverified' }),
    project('archive-atlas', 'Archive Atlas', 'resource', 'reference',
      '为示例项目提供进度术语与记录格式。',
      '补充进度术语表与里程碑的记录说明。'),
  ];
  const news = [
    ['demo-aurora-frame', `${SAMPLE_DAY}T09:00:00Z`, 'Aurora Runner 增加首帧记录'],
    ['demo-frame-start', '2026-01-11', 'Frame Lab 记录程序启动阶段'],
    ['demo-score-copy', '2026-01-10', '更正：部分完成的里程碑仍显示为待完成', true],
    ['demo-archive', '2026-01-09', '工程档案增加证据详情'],
    ['demo-project-stats', '2026-01-08', '资源卡片补充指标和状态'],
    ['demo-launch', '2026-01-07', '建立本地演示数据集'],
  ].map(([id, date, title, correction]) => ({ id, date, title, correction: correction === true }));
  const content = {
    home: { latestUpdate: '已收录 5 个虚构项目。查看新闻时间线和工程档案，了解示例进度。', autoNewsCount: 2 },
    countdown: { enabled: true, label: '示例活动倒计时', target, source: '演示用计时器。每次启动后从 7 天开始计时。', buttons: [] },
    roadmap: {
      playability: { summary: '此页的全部阶段与评分均来自虚构样例。' },
      gameplayProgress: {
        title: '里程碑样例', note: '选择阶段查看对应的演示记录。',
        milestones: EXPECTED_STEPS.map((label, index) => ({
          id: `example-step-${index + 1}`, label, status: index > 1 ? 'planned' : 'completed',
          ...(index > 1 ? {} : { evidence: '此阶段使用虚构场景演示证据面板。', sourceUrl: '#about' }),
        })),
      },
    },
    announcements: {
      source: '#about', checkedOn: SAMPLE_DAY,
      items: [
        { datetime: SAMPLE_DAY, title: '本地演示数据就绪', summary: '首页、RSS、里程碑和工程档案共享同一组示例内容。', buttons: [{ label: '查看工程档案', url: '#dashboard' }] },
        { datetime: '2026-01-11', title: '归档可按需展开', summary: '首页先显示部分卡片。使用列表下方的按钮展开余下条目。' },
        { datetime: '2026-01-10', title: '时间线可订阅', summary: '通过 RSS 订阅这个本地演示的时间线。' },
        { datetime: '2026-01-09', title: '里程碑证据面板', summary: '选择阶段查看样例证据和备注。' },
      ],
    },
    downloads: { items: [], note: '此演示提供工程档案与 RSS。' },
    news,
    projects,
    community: { groups: [] },
  };
  const statistics = [[128, 19, 4], [72, 11, 5], [64, 8, 2], [38, 4, 2], [20, 6, 0]];
  const metadata = new Map(projects.map(({ repo }, i) => {
    const [stars, forks, openIssues] = statistics[i];
    return [repo, { stars, forks, openIssues, pushedAt: new Date(now - i * DAY).toISOString() }];
  }));
  const traffic = { online: 12, totalVisits: 2480, windowSeconds: 90, scope: 'local', sample: true };
  const trafficHistory = {
    windowSeconds: 6 * 3600, sampleSeconds: 1800, asOf: now,
    points: [4, 7, 6, 9, 12, 13, 8, 11, 14, 10, 14, 15, 12].map((online, index) => ({
      time: now - (12 - index) * 1800 * 1000, online, totalVisits: traffic.totalVisits - (12 - index) * 16,
    })),
  };
  const history = [22, 25, 32.5, 40, 46].map((leader, index) => ({ date: `2026-01-${8 + index}`, leader }));
  const sponsors = [
    { id: 'demo-type', nickname: '排版样例', message: '展示章节标题、卡片和移动端排版。' },
    { id: 'demo-motion', nickname: '交互样例', message: '展示键盘导航、折叠区与星图。' },
    { id: 'demo-fixture', nickname: '数据样例', message: '展示虚构项目和里程碑在页面上的布局。' },
  ];
  return { content, metadata, traffic, trafficHistory, history, sponsors };
}

module.exports = { createFixtures };
