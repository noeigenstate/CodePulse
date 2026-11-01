> 历史技术记录；版本与已验证范围以当时正文为准。当前构建、仓库入口和实机状态见 [firmware README](../README.md)。

# 0.0.29 日历与全局字体 · 方案 C 原生单色修订

2026-10-30返工，基于`0319935`。版本仍为`0.0.29-calendar`，PAIR150/region后缀不变。
本修订替代上一版Unifont16/Fusion12视觉方案。SDK仍为ESP-IDF6.0.1，锁文件、GPIO、
PWR_HOLD、驱动波形、按键及刷新调度未改。未提交、未推送、未烧录或访问设备。

## 原生字体与完整覆盖

| 用途 | 中文 | 数字、拉丁 |
| --- | --- | --- |
| 正文、普通元信息、状态 | Noto Sans SC Regular 2.004，14px | Noto Sans Bold 2.008，16px |
| 标题、宠物台词 | 同源SC16px Regular | 同源Sans20px Bold |
| 徽章、紧凑汇总 | SC14 | Sans14 |
| 普通页眉 | SC14 | Sans12 |
| 日历农历、星期、角标 | 封闭词表SC12，其他码位回退正文SC14 | Sans12；词表外回退正文Latin16 |
| 普通日期、年月数字 | 完整SC16回退 | Sans24原生 |
| 六行日期 | 完整SC16回退 | Sans20原生 |
| 用量大数字 | 完整SC16回退 | Sans40原生 |

中文不做1px合成加粗；所有字号直接以FreeType MONO生成，开启字体自有hinting，
参数为`FT_LOAD_RENDER | FT_LOAD_TARGET_MONO | FT_LOAD_MONOCHROME | FT_LOAD_NO_BITMAP`。
未先生成灰度再阈值化，没有运行期轮廓字体解析器，生产页面不调用整数放大API。
原缩放API仅为旧probe源码兼容而保留；比较总览才使用2倍最近邻。

14个语义层级均可绘制既有7752码位。仅保留SC14/16两套共享通用表；原生Latin16/20
已在其中，不再存放未引用的重复小表。另有12/14/24/40四张Latin小表和一张207码位日历12px小表。
原生小表只覆盖相应字符，未命中的中文始终走完整通用表，不能把它当中文全字库。
U+2212数学减号由同字号原生Noto SC提供，未拿缺字符号代替。

全部6763汉字由NotoSC原生提供；34个DEL/C1/保留兼容码位保留Unifont18.0.01原掩码，
没有普通中文或正文使用Fusion/Unifont。范围外仍走既有U+FFFD策略，不扩充Unicode域。

## 来源、许可证与两段生成链

字体原文件、版本、SHA-256、版权及许可证路径见`fonts/SOURCE.txt`、
`fonts/sources/noto-sources.json`。TTF/OTF及许可证逐字入库，Git属性保护原始字节。
旧pixel-hierarchy/noto-hierarchy源包保留供历史研究复现，当前生成器不嵌入它们。

源掩码阶段需要固定工具FreeType2.13.2和freetype-py2.5.1，只在开发机运行：

```powershell
python -B scripts/generate-native-font-masks.py --freetype-path tmp/f3/vendor
```

它固定源文件哈希，记录原生advance、bearing、MONO掩码和版本，输出
`noto-native-masks.json/.bin.gz`。atlas阶段只用标准库：

```powershell
python -S scripts/generate-display-font.py --write-source
python tests/test_bitmap_fonts.py build-quiet-tests/display-font-cells.pgm
```

最终`native-hierarchy.json/.bin.gz`及C头共享原始掩码，不重新栅格化。
8字节记录为u24位图偏移、u8像素advance、i8 left/top、u8 width/height。
压缩前对每张表的偏移做delta24无损编码，miniz展开后一次还原，不改变任何字形。
压缩atlas309408字节，展开578597字节；上一轮为417743/809324字节，
0.0.28为395971/1086869字节。位图池小于16MiB，生成器检查24位偏移边界。

### 分区预算与日历封闭字符集

本轮保留已验收的字体、字号和版式，只裁剪12px表的覆盖并共享正文回退。
`scripts/generate-calendar-font-charset.mjs`只读加载桌面日历模块，枚举1900—2100全部
73414天、2412个月，得到95种label及农历年月日字符；补入星期、一二三四五六日、年月、第周班。
原模块输出及界面固定文字共99码位，另明确保留已验收压力串「春节快乐」「四字标签」「Ág中」
增加的7码位。与原Latin12合并、去重后，207码位保留原生12px，其他7545码位回退正文层。
`fonts/sources/calendar-charset.json`保存全部字符串、排序码位及桌面六个源文件的LF哈希。

```powershell
node scripts/generate-calendar-font-charset.mjs --module <desktop calendar directory> --check
```

普通atlas构建只读该JSON，不依赖桌面仓库或Node；全码位测试逐个核对实际选中字形与原始掩码。
允许自定义的词表外label现在使用正文14px（拉丁16px），四字串可能进入原有安全省略规则；
不会侵入邻格。系统日历标签和已验收四字样本仍为原生12px，不改变任何墨点。

同一MSVC x64 `/O1 /Gy`口径，display_text/quiet_dashboard/protocol三单元合计：
0.0.28为453791 B，上轮459939 B，本轮352021 B，比0.0.28少101770 B。
合计是压缩atlas加代码与其余只读数据，atlas只计一次；满足至少节省8192 B的预算。
代码与只读数据仍是host估计，ESP32-S3最终镜像及分区余量须用目标链接/map确认。
可重跑`scripts/test-font-budget.py --baseline <0.0.28 tree> --previous <approved C tree> --output <directory>`。
展开atlas比0.0.28少508272 B，未增加解压依赖或运行期分配。

构建器额外输出`tmp/preview-out/THIRD-PARTY-FONTS.txt`，包含实际嵌入的Noto Sans Bold、
Noto Sans SC Regular及兼容Unifont的名称、版本、版权、源URL、SHA和完整许可原文。
声明不含固件源码或私有路径；公开桌面端同步Wasm时同时分发该文件。

## 全屏月历

| 区域 | 原生400×300位置 |
| --- | --- |
| 年月 | x=12起、基线29；年份黑、月份红，数字24px原生 |
| 农历与ISO周 | 右侧，常规基线13/34；极长副标题最多3行 |
| 电量 | 右上角小图标；不显示品牌、温湿度、联网或电量数字 |
| 星期栏 | y=42–59，周一开始；工作日黑底、周末红底、白字 |
| 日期区 | y=63–297，7列53/54px；按4/5/6行均分，五行47px |

去掉「休」角标，保留「班」黑字。flag4仍保留并使日期/标签红色；flag1同样采用
日期与标签整组红，flag2仅标签红，flag8显示班字。位4/8仍互斥，传输格式未变。
非今天班日日期中轴左移3px，为角标留空间；不整体缩放日期。

今天是整数几何红色实心圆，直径不超过46px，也不越出本格。
先用实际字形的每个墨点检查日期与标签能否同时放入圆；能放入则两行白字。
放不下时圆内只留日期，完整标签用原生12px红字放在普通标签基线，圆与标签保留空行。
为满足这个规则，日期圆按空间选择24/20/16/14/12原生strike；不会缩位图或剪白笔画。
普通五行四字标签与六行四字标签样本均保留完整四字，标签不侵入相邻格。
合法普通四字中文宽度不超过48px；对非常规超宽兼容控制输入仍沿用安全单行省略边界。

反色先沿用整屏黑白翻转、保留红色，再只回放今天圆内已验证的白字。
圆外红色标签、普通日期、角标继续按原有黑白/红规则处理，今天白字不会变成黑字。
仅在进入红色受冷却限制、实际输出降级为黑白时，反色模式会把圆折为白色前景；
此时圆内文字恢复黑色对比，避免白底白字。该路径没有红圆，不改变全刷或冷却时序。

## 其它页面与英文断行

普通页眉、HUD、用量、文字卡、宠物均使用同一Noto体系。宠物图框仍为
(8,32)、384×208，分割线y=243；台词SC16/Latin20、基线268，超过376px
回退正文SC14/Latin16、基线266；来源正文14、基线293。
用量百分比使用原生40px；未用整数放大。

换行视`[A-Za-z0-9_.-]`连续串为单词，余宽不足时整个单词移到下一行；
只有一个词超过整行宽度时才允许在词内分段。两行标题仍放不下才在最后一行省略，
末行省略不生成下一行的词尾。测试覆盖open-water、project_2026-v1、v1.2_3-id。

## 日历协议与刷新保持

合法`layout:"calendar"`优先忽略图片；calendar字段错误时回到原图片卡/文字卡，
不是强制删图。year1900–2100；month1–12；days必须匹配公历月份及世纪闰年；
first0–6；today为0或1..days；week1–53；lunar最多32字节UTF-8；
labels/flags长度等于days；每个label最多4码位、16字节，允许空串与非汉字。
完整夹具仍在`preview/fixtures/calendar-*.json`，数据来自桌面D1模块。

月历不追加普通页脚。红平面由实际渲染决定，不能用ambient.red/has_red判断日历是否有红。
三色全刷、120秒进入冷却、清红、故障锁止、同id冻结均保持，无新增时钟或定时刷新。

## 验证与基线

```powershell
scripts/test-host.ps1
scripts/test-quiet.ps1
scripts/test-preview.ps1 -Zig <zig-0.13.0> -Loader <read-only renderer.mjs>
```

host仍为199个日历解析用例。quiet新增/修改测试使用始终执行的CHECK，不把被测操作
放进可被NDEBUG裁掉的assert。日历有84个邻格不变检查、86个真实圆形/白字反色检查，
覆盖0–4码位、3字节中文、拉丁、4/5/6行、今天为班日；普通和NDEBUG构建均执行。
字体测试逐记录比对原始MONO掩码与bearing，14层级×7752码位；Python -O也不会跳过检查。
116组native/Wasm双平面一致，另有400次黑白、400次双平面交错渲染。

本轮字体及全屏版式使0.0.29旧像素必然变化。沿用原65黑白+11红色输入，
基线文件`preview/baselines/0.0.29-calendar.json`增加C修订标识，经审图显式更新；
常规preview脚本只核验，不自动批准新像素。`-UpdateBaseline`只用于审图后的有意更新。

第三轮体积优化未更新该像素基线；与保存的已验收C版比较，116组native/Wasm用例、
原65+11组输入的黑红平面逐字节不变。`quiet_dashboard.c`与`codepulse_protocol.c`本轮也未改。

最终产物`tmp/preview-out/`。manifest仍规范化文本LF；新增原生源掩码记录与来源/许可文本，
二进制源由JSON中的原始SHA固定。具体差集、Wasm和图像哈希见本轮报告。
`tmp/r3/`包含14张正常设备图、长标签/班日压力图、2400×3000两倍最近邻总览，
以及左参考照片区域/右当前月历的1600×600对比。参考水印、模糊和透视保留。

## 未验证

无ESP-IDF，未执行ESP32-S3目标编译，应用分区和启动堆余量仍需目标链接/map确认。
未访问硬件，供电、Wi-Fi、显色/清红、刷新耗时、残影与长期稳定性均未实测。
PNG和驱动模型检查不能替代实机光学验收。
