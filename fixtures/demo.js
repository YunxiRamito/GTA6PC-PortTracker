'use strict';

const { BENCHMARK_PROFILE, BENCHMARK_SEGMENTS, BENCHMARK_FLAGS, scoreProject } = require('../assets/port-score');

const DAY = 24 * 60 * 60 * 1000;
const SAMPLE_DAY = '2026-01-12';
const EXPECTED_STEPS = [
  ['准备示例场景', 'Prepare the sample scene', 'サンプルシーンを準備'],
  ['呈现首帧', 'Render the first frame', '最初のフレームを描画'],
  ['打开主菜单', 'Open the main menu', 'メインメニューを開く'],
  ['进入场景', 'Enter the scene', 'シーンに入る'],
];

function withCopy(record, en, ja) {
  return { ...record, translations: { en, ja } };
}

function fieldCopy(record, field, en, ja) {
  return withCopy(record, { [field]: en }, { [field]: ja });
}

const projectCopy = {
  'aurora-runner': {
    en: { summary: 'A compatibility-layer sample. A test scene demonstrates startup through initial rendering.', progress: 'The sample scene has rendered its first frame. The main menu is partly complete.' },
    ja: { summary: '互換レイヤーのサンプルです。テストシーンで起動から初回描画までを紹介します。', progress: 'サンプルシーンの初回描画は完了し、メインメニューは一部完成しています。' },
    tested: ['Aurora sample scene', 'Aurora のサンプルシーン'], blocker: ['Menu interaction is still unverified.', 'メニュー操作は未確認です。'],
  },
  'frame-lab': {
    en: { summary: 'A rendering compatibility sample that splits setup into individual steps.', progress: 'The sample program starts. First-frame progress has not been updated.' },
    ja: { summary: '準備作業を個別の段階に分けた描画互換性のサンプルです。', progress: 'サンプルプログラムの起動を記録済みです。初回描画の進捗は未更新です。' },
    tested: ['Offline rendering sample', 'オフライン描画のサンプル'],
  },
  'shader-notebook': {
    en: { summary: 'A sample tool that records rendering inputs, outputs, and known limits.', progress: 'Added a test log template and examples organized by version.' },
    ja: { summary: '描画実験の入力、出力、既知の制約を記録するサンプルツールです。', progress: 'テスト記録のひな型とバージョン別のサンプルを追加しました。' },
    tested: ['Graphics test sample', 'グラフィックステストのサンプル'],
  },
  'input-garden': {
    en: { summary: 'A sample tool for archiving keyboard and controller interaction tests.', progress: 'Added samples for keyboard focus and switching controllers.' },
    ja: { summary: 'キーボードとコントローラーの操作テストを記録するサンプルツールです。', progress: 'キーボードフォーカスとコントローラー切り替えのサンプルを追加しました。' },
    tested: ['Input test sample', '入力テストのサンプル'],
  },
  'archive-atlas': {
    en: { summary: 'Progress terminology and record templates for sample projects.', progress: 'Expanded the glossary and milestone recording guide.' },
    ja: { summary: 'サンプルプロジェクト向けの進捗用語と記録書式です。', progress: '用語集と到達段階の記録方法を補足しました。' },
  },
};

function project(repo, title, type, status, summary, progress, portProgress, evidence) {
  const { en, ja, tested, blocker } = projectCopy[repo];
  const localizedEvidence = evidence && withCopy(evidence,
    { tested: tested[0], ...(blocker && { blocker: blocker[0] }) },
    { tested: tested[1], ...(blocker && { blocker: blocker[1] }) });
  return withCopy({ repo: `demo-workshop/${repo}`, title, type, status, summary, progress, portProgress, evidence: localizedEvidence }, en, ja);
}

function demoQuality(id, measured) {
  const { id: profileId, routeId, preset, width, height } = BENCHMARK_PROFILE;
  const benchmark = { profileId, routeId, preset, width, height,
    ...Object.fromEntries(BENCHMARK_FLAGS.map(key => [key, false])) };
  if (measured) {
    const syntheticFps = [[18, 60, 62], [64, 65, 68], [54, 55, 57]];
    benchmark.segments = BENCHMARK_SEGMENTS.map((id, index) => ({
      id, runs: syntheticFps[index].map(fps => ({ frames: fps * 20, seconds: 20 })),
    }));
  }
  return {
    evidence: {
      // The loopback URL is a placeholder; the fixture never fetches evidence.
      level: 'reproduced', sourceUrl: `https://localhost/#${id}`, build: `synthetic-${id}-v5`,
      setup: 'Synthetic reference profile, native 1080p', observedOn: SAMPLE_DAY,
    },
    benchmark,
    rendering: { segments: BENCHMARK_SEGMENTS.map(id => ({
      id, severity: measured && id === 'yard' ? 'localized' : 'clean',
    })) },
  };
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
    ['demo-aurora-frame', `${SAMPLE_DAY}T09:00:00Z`, 'Aurora Runner 增加首帧记录', 'Aurora Runner records its first frame', 'Aurora Runner が最初のフレームを記録'],
    ['demo-frame-start', '2026-01-11', 'Frame Lab 记录程序启动阶段', 'Frame Lab records program startup', 'Frame Lab がプログラムの起動を記録'],
    ['demo-score-copy', '2026-01-10', '更正：部分完成的里程碑仍显示为待完成', 'Partly completed milestones still appear as incomplete', '一部完了した段階は未完了として表示', true],
    ['demo-archive', '2026-01-09', '工程档案增加证据详情', 'The project archive adds evidence details', 'プロジェクト一覧に根拠の詳細を追加'],
    ['demo-project-stats', '2026-01-08', '资源卡片补充指标和状态', 'Resource cards gain metrics and status labels', '資料カードに指標と状態を追加'],
    ['demo-launch', '2026-01-07', '建立本地演示数据集', 'The local demo dataset is created', 'ローカルデモのデータセットを作成'],
  ].map(([id, date, title, en, ja, correction]) => fieldCopy({ id, date, title, correction: correction === true }, 'title', en, ja));
  const content = {
    home: fieldCopy({ latestUpdate: '已收录 7 个虚构项目。查看新闻时间线和工程档案，了解示例进度。', autoNewsCount: 2 }, 'latestUpdate',
      'Seven fictional projects are listed. See the news timeline and project archive for example progress.',
      '架空のプロジェクトを7件掲載しています。進捗のサンプルはニュースタイムラインとプロジェクト一覧で確認できます。'),
    countdown: withCopy({ enabled: true, label: '示例活动倒计时', target, source: '演示用计时器。每次启动后从 7 天开始计时。', buttons: [] },
      { label: 'Example event countdown', source: 'Demo timer. Each launch starts a new seven-day countdown.' },
      { label: 'サンプルイベントのカウントダウン', source: 'デモ用タイマーです。起動するたびに7日間のカウントダウンが始まります。' }),
    roadmap: {
      playability: fieldCopy({ summary: '此页的全部阶段与评分均来自虚构样例。' }, 'summary',
        'All stages and scores on this page come from fictional examples.', 'このページの段階とスコアはすべて架空のサンプルに基づきます。'),
      privateRepositories: [
        withCopy({ id: 'sample-launch', title: '启动验证样例', summary: '虚构构建：已完成监狱序章验证，含原生 1080p 的画面与帧率样例。',
          sourceLabel: '演示说明', sourceUrl: '#about',
          portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, prison: 1, qualityV5: demoQuality('sample-launch', true) }, verification: 'verified' } },
          { title: 'Startup verification sample', summary: 'A fictional prison-intro build with sample rendering and frame-rate measurements at native 1080p.', sourceLabel: 'Demo notes' },
          { title: '起動検証のサンプル', summary: '刑務所の序章を検証した架空のビルドです。ネイティブ1080pの描画とフレームレートの測定例を含みます。', sourceLabel: 'デモの説明' }),
        withCopy({ id: 'sample-render', title: '渲染准备样例', summary: '虚构构建：已记录画面表现，参考机帧率待测。',
          sourceLabel: '演示说明', sourceUrl: '#about',
          portProgress: { gta: { loads: 1, boots: 1, menu: 1, ingame: 1, prison: 1, qualityV5: demoQuality('sample-render', false) }, verification: 'verified' } },
          { title: 'Rendering setup sample', summary: 'A fictional build with documented rendering and no reference-machine frame-rate runs yet.', sourceLabel: 'Demo notes' },
          { title: '描画準備のサンプル', summary: '描画は確認済みですが、基準機でのフレームレートは未計測の架空のビルドです。', sourceLabel: 'デモの説明' }),
      ],
      gameplayProgress: withCopy({
        title: '里程碑样例', note: '选择阶段查看对应的演示记录。',
        milestones: EXPECTED_STEPS.map(([label, en, ja], index) => {
          const record = { id: `example-step-${index + 1}`, label, status: index > 1 ? 'planned' : 'completed' };
          if (index > 1) return fieldCopy(record, 'label', en, ja);
          return withCopy({ ...record, evidence: '此阶段使用虚构场景演示证据面板。', sourceUrl: '#about' },
            { label: en, evidence: 'A fictional scene demonstrates the evidence panel for this stage.' },
            { label: ja, evidence: 'この段階では架空のシーンを使って根拠パネルを紹介します。' });
        }),
      }, { title: 'Example milestones', note: 'Select a stage to view the corresponding demo record.' },
      { title: '到達段階のサンプル', note: '段階を選ぶと対応するサンプル記録を確認できます。' }),
    },
    announcements: {
      source: '#about', checkedOn: SAMPLE_DAY,
      items: [
        withCopy({ datetime: SAMPLE_DAY, title: '本地演示数据就绪', summary: '首页、RSS、里程碑和工程档案共享同一组示例内容。',
          buttons: [fieldCopy({ label: '查看工程档案', url: '#dashboard' }, 'label', 'View the project archive', 'プロジェクト一覧を見る')] },
          { title: 'Local demo data is ready', summary: 'The home page, RSS feed, milestones, and archive share the same sample data.' },
          { title: 'ローカルデモデータの準備が完了', summary: 'ホーム、RSS、到達段階、プロジェクト一覧で同じサンプルデータを使います。' }),
        withCopy({ datetime: '2026-01-11', title: '归档可按需展开', summary: '首页先显示部分卡片。使用列表下方的按钮展开余下条目。' },
          { title: 'Expand the archive on demand', summary: 'The homepage starts with a few cards. Use the button below the list to show the rest.' },
          { title: '一覧は必要に応じて展開', summary: 'ホームには最初に一部のカードを表示します。残りは一覧の下にあるボタンで表示できます。' }),
        withCopy({ datetime: '2026-01-10', title: '时间线可订阅', summary: '通过 RSS 订阅这个本地演示的时间线。' },
          { title: 'Subscribe to the timeline', summary: 'Follow the local demo timeline via RSS.' },
          { title: 'タイムラインを購読', summary: 'RSS でローカルデモのタイムラインを購読できます。' }),
        withCopy({ datetime: '2026-01-09', title: '里程碑证据面板', summary: '选择阶段查看样例证据和备注。' },
          { title: 'Milestone evidence panel', summary: 'Choose a stage to see example evidence and notes.' },
          { title: '到達段階の根拠パネル', summary: '段階を選ぶとサンプルの根拠と注記を確認できます。' }),
      ],
    },
    downloads: fieldCopy({ items: [], note: '此演示提供工程档案与 RSS。' }, 'note',
      'The demo provides the project archive and RSS feed.', 'このデモではプロジェクト一覧と RSS を利用できます。'),
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
  // This fixed preview series is synthetic and uses only V5 scores.
  const sampleLeader = scoreProject(content.roadmap.privateRepositories[0]).score;
  const history = [15, 30, 35, 50, sampleLeader].map((leader, index) => ({ date: `2026-01-${String(8 + index).padStart(2, '0')}`, leader }));
  const sponsorRows = [
    ['demo-type', ['排版样例', '展示章节标题、卡片和移动端排版。'],
      ['Typography sample', 'Demonstrates headings, cards, and mobile layout.'],
      ['レイアウトのサンプル', '見出し、カード、モバイルでの配置を確認できます。']],
    ['demo-motion', ['交互样例', '展示键盘导航、折叠区与星图。'],
      ['Interaction sample', 'Demonstrates keyboard navigation, disclosure panels, and the star map.'],
      ['操作のサンプル', 'キーボード操作、折りたたみパネル、星図を確認できます。']],
    ['demo-fixture', ['数据样例', '展示虚构项目和里程碑在页面上的布局。'],
      ['Data sample', 'Shows where fictional projects and milestones appear on the page.'],
      ['データのサンプル', '架空のプロジェクトや到達段階の表示位置を確認できます。']],
  ];
  function localizedSponsors(locale) {
    const index = locale === 'en' ? 2 : locale === 'ja' ? 3 : 1;
    return sponsorRows.map(row => {
      const [nickname, message] = row[index];
      return { id: row[0], nickname, message };
    });
  }
  return { content, metadata, traffic, trafficHistory, history, sponsors: localizedSponsors(), localizedSponsors };
}

module.exports = { createFixtures };
