# zcode-start-plan-relay

[English](README.md) | [简体中文](README.zh-CN.md) | 日本語

ZCode（Z.ai のデスクトップ型コーディングエージェント）に内蔵された無料の
**Start Plan** を、標準的な **Anthropic Messages 互換エンドポイント** に変換し、
[magpie](https://github.com/yetone/magpie) や Claude Code、Codex など
base URL を設定できるあらゆるエージェントから使えるようにします。
シングルファイル・依存ゼロ・Node 18+・クロスプラットフォーム。

> ⚠️ **必ず自分のアカウントとクォータのみで使用してください。** 本プロジェクトは
> Z.ai / 智谱 / ZCode 公式とは無関係です。利用規約に抵触するかどうかは自己判断で、
> 不正対策のルールはいつでも変更される可能性があり、動作を保証しません。

```
エージェント ──► リレー (127.0.0.1:8791) ──► https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
                    │
                    └─ 呼び出しごとに ZCode の認証情報ストアから有効なログイン
                       JWT を復号し、ゲートウェイが受け付ける形にリクエストを整形
```

---

## 背景：Start Plan を直接使えない理由

ZCode はログイン後にいくつかの「アカウント型」プロバイダを内蔵しています。
そのひとつが **Start Plan**（プロモーション プラン。`billing/current` は
`zcode-v3-start-plan-referral`、"ZCode Global Build" と報告）です。実際の
上流は次のとおり：

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
```

トークンを持って自分から呼んでも拒否されます。関門は二つあります。

### 門 1：トークンは暗号化されており、平文のコピーは古い

- 有効なトークンは `~/.zcode/v2/credentials.json` の `zcodejwttoken` で、
  `enc:v1:<iv>.<tag>.<data>`（base64url）形式。暗号は **AES-256-GCM**、
  鍵 = `sha256(secret)`。secret は `ZCODE_CREDENTIAL_SECRET`、無ければ
  `zcode-credential-fallback:<platform>:<homedir>:<username>` という文字列。
- `~/.zcode/v2/config.json` の `builtin:bigmodel-start-plan.options.apiKey`
  にある平文 JWT は過去の残骸です。実測では 401 で拒否され、復号した
  有効トークンのみが受け入れられます。
- ZCode 自身のリクエスト署名レイヤ（`X-Client-Sig` / `X-Client-Pow` など）は
  Start Plan には **適用されません**。ZCode のログには
  `model.client_signing.unsigned_sent`（理由 `access_mode`）が記録されます。

### 門 2：リクエストは「ZCode そのもの」の形であること

*有効な* トークンでも、最小のリクエストはエッジにブロックされます：

```
HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}
```

制御実験（同じ有効トークンで要素をひとつずつ変える）から得られた規則：

| リクエストボディ | 結果 |
|---|---|
| `messages` のみ | **ブロック（3012）** |
| `messages` + 小さな system | **ブロック（3012）** |
| `messages` + ZCode の実際の 55 個の tools、system なし | **ブロック（3012）** |
| 実際の tools + **ZCode 自身の system プリアンブル** | **200（SSE 正常）** |
| その上で tool を 1 個追加 / 削除 | 200 |
| プリアンブル内の cwd / セッション文字列を書き換え | 200 |
| `system` を第 1 ブロックのみに | **ブロック（3012）** |
| `system` = 最初の 2 ブロック | 200 |
| 呼び出し元の system を **さらに 1 ブロックとして追加** | 200（実際に従われる） |
| 第 1 ブロック **の中に** 文字を追加 | **ブロック（3012）** |

要約：**ZCode の system プリアンブルの最初の 2 ブロックが必要
（第 1 ブロックは原文のまま）**。tools・messages・追加の system ブロックは自由です。

### リレーが行うこと

1. 呼び出しごとに `credentials.json` から有効トークンを復号（mtime キャッシュ）。
   401 を受けると一度だけ強制再読み込みしてリプレイするため、ZCode の
   アカウント切り替えや再ログインでも **何も再起動する必要がありません**。
2. `system` には ZCode の最初の 2 ブロックを使います。プレランブルは
   **本リポジトリには同梱しません**（Z.ai のプロンプトだからです）：初回起動時に
   ローカルの ZCode model-io ログ（`~/.zcode/cli/rollout/model-io-*.jsonl`）
   から抽出し、スクリプトの隣にキャッシュします。
3. 呼び出し元の system プロンプトは、さらに 1 ブロックとして付加します。この形が
   エッジに拒否された場合は、自動的に「最初の user メッセージに組み込む」形で
   再試行します。
4. `model` のマッピング：プランで使えるのは `GLM-5.3` と `GLM-5.3-Flash` のみ。
   それ以外（Claude 系の名前など）はデフォルトモデルにフォールバックします。
5. ZCode のクライアントヘッダ（`user-agent: ZCode/3.16.3`、`x-zcode-agent:
   glm`、`x-zcode-app-version` など）を付与します。
6. SSE も非ストリーミングもそのまま透過。tool 呼び出しも機能します。

## クイックスタート

前提条件：

- ZCode がインストール・ログイン済みで、アカウントに実際に Start Plan がある
  （`~/.zcode/v2/coding-plan-cache.json` の該当エントリが `available`）；
- **ZCode 内で Start Plan モデルを使って少なくとも 1 回メッセージを送ったことがある**
  （ZCode が model-io ログを書き出し、そこからプレランブルを抽出します）；
- Node 18+。

```bash
node zcode-plan-relay.js
# listening on http://127.0.0.1:8791
curl http://127.0.0.1:8791/health
```

Windows 用の簡易スクリプト（バックグラウンド起動してヘルスを表示）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

初回起動時に `preamble extracted from model-io-….jsonl` と表示され、スクリプトの
隣に `zcode-plan-preamble.json` が生成されます（git-ignore 済み。配布しないでください）。

### magpie から使う

```bash
magpie provider add "ZCode Start Plan" \
  anthropic=http://127.0.0.1:8791 key=zcode-plan models=GLM-5.3,GLM-5.3-Flash
magpie claude zcode-start-plan/GLM-5.3
```

### その他のエージェントから使う

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8791
export ANTHROPIC_API_KEY=whatever          # ZCODE_PLAN_KEY 未設定なら検査なし
```

（OpenAI 形式のクライアントは、このプロバイダを登録した magpie ゲートウェイに
向ければ magpie が API 間を翻訳します。独自の変換層を挟んでも構いません。）

### LAN 共有 / リモートの magpie から使う

リレー自体を公開する：

```bash
HOST=0.0.0.0 ZCODE_PLAN_KEY=<長い秘密の文字列> node zcode-plan-relay.js
```

または magpie 全体を共有します（リモート側はこのマシンのすべてのプロバイダ・
アカウント・ルーティンググループを使えます。モデル ID は
`office/zcode-start-plan/GLM-5.3` のようになります）：

```bash
# このマシン
magpie gateway-key add "remote"            # sk-magpie-key-… を一度だけ表示
MAGPIE_ADDR=0.0.0.0:3425 magpie serve
# 相手のマシン
magpie provider add remote-magpie sk-magpie-key-… url=http://<このホスト>:3425 id=office
magpie claude office/zcode-start-plan/GLM-5.3
```

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/v1/messages`（`/messages` も可） | Anthropic Messages。ストリーミング / 非ストリーミング両対応 |
| GET | `/v1/models` | モデル一覧（magpie はここからカタログを取得） |
| GET | `/health` | トークン状態・user id・モデル一覧 |

## 設定（環境変数）

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` / `HOST` | `8791` / `127.0.0.1` | 待ち受けポート / アドレス |
| `ZCODE_PLAN_MODEL` | `GLM-5.3-Flash` | 不明なモデル名のフォールバック先 |
| `ZCODE_PLAN_KEY` | 空 | 設定すると呼び出し元に要求（`Authorization: Bearer` または `x-api-key`）。LAN 公開時は必ず設定 |
| `ZCODE_PLAN_UPSTREAM` | `https://zcode.z.ai` | 上流オリジン |
| `ZCODE_PLAN_PREAMBLE` | スクリプト隣の `zcode-plan-preamble.json` | プレランブルのキャッシュ先 |
| `ZCODE_PLAN_ROLLOUT` | `~/.zcode/cli/rollout` | プレランブル抽出時に走査するログディレクトリ |
| `ZCODE_PLAN_LOG` | `%TEMP%\zcode-plan-relay.log` | ログファイル |
| `ZCODE_PLAN_VERBOSE` | オフ | `1` で標準出力にもログ |
| `ZCODE_CREDENTIAL_SECRET` | フォールバック文字列 | ZCode の認証情報暗号鍵（通常は未設定で可） |

## 制限と既知の問題

- プランで使えるのは `GLM-5.3` と `GLM-5.3-Flash` のみ。その他のモデル名は
  上流で拒否されるか（`3006 model not allowed`）、デフォルトにフォールバック。
- system の主導権は ZCode 側にあります。プレランブルは常に存在し、呼び出し元の
  指示は追加ブロックとして後ろに付きます（従うことは実証済みですが、ネイティブな
  system ロールではありません）。
- クォータは自分の Start Plan から消費されます。期限と容量のあるプロモーション
  プランです。
- 門 2 は固定のチェックサムではなく振る舞い検知です。Z.ai はいつでも変更でき、
  リレーは動かなくなる可能性があります。
- リレーは呼び出し元の `tools` と会話をそのまま保持しますが、ZCode 自身の
  リクエストに合わせて `thinking` / `output_config` のデフォルトを常に補います。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `/health` が `token.ok: false` | ZCode 未ログイン / 認証情報ファイルなし。ZCode でログインする |
| 起動ログに `preamble not extracted` | ZCode 内で Start Plan モデルを使って一度メッセージを送り、リレーを再起動 |
| `upstream 405 … 3012` | 形状を拒否された：プレランブルファイルの破損が疑わしい（第 1 ブロックは原文のまま） |
| `upstream 400 … model not allowed` | プラン外のモデルを要求した |
| 401 が続く | トークンが本当に無効：ZCode で再ログイン。リレーは自動で再読み込み |

## リバースエンジニアリングの概要

1. ZCode 同梱 CLI（`resources/glm/zcode.cjs`）の静的解析：プランのエンドポイント
   定数、認証情報の暗号実装（`createZCodeCredentialCipher`）、クライアント署名
   レイヤとその `access_mode` によるスキップ。
2. ZCode 自身の model-io ログ（`~/.zcode/cli/rollout/*.jsonl`）：実際の
   リクエストの完全な形（認証ヘッダは ZCode 自身がマスク、それ以外はそのまま）。
3. 上流への制御実験（同じ有効トークンで要素をひとつずつ増減）→ 上記のゲート
   マトリクス。
4. magpie 側は公式ドキュメントとソースから、消費側で使う custom provider
   （`anthropic=`）と Remote magpie の仕組みを確認。

## リポジトリ構成

| パス | 用途 |
|---|---|
| `zcode-plan-relay.js` | リレー本体（シングルファイル・依存ゼロ） |
| `scripts/start-windows.ps1` | Windows でバックグラウンド起動しヘルスを表示 |
| `zcode-plan-preamble.json` | 初回起動時にローカル生成——**コミット・配布しないこと** |

## License

[MIT](LICENSE)
