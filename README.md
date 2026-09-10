# 案件管理ダッシュボード

このフォルダがダッシュボードの正本です。公開用ファイルは常に `index.html` で、修正のたびに `dashboard_v60.html` のような複製を作る必要はありません。過去の状態はGitのコミットから復元できます。

## 普段の流れ

1. ChatGPTデスクトップでこのフォルダのプロジェクトを開く。
2. 修正内容を伝え、実装・表示確認・テストまで依頼する。
3. HTMLプレビューと変更差分を確認する。
4. 問題がなければ「GitHubへ公開して」と伝える。

Codexが `index.html` と必要な関連ファイルを直接更新し、公開依頼時にコミットとpushを行います。

## 確認コマンド

Googleカレンダー連携のロジックテスト：

```sh
node --test tests/calendar-sync.test.cjs
```

PlaywrightとChromiumが利用できる場合の画面テスト：

```sh
node tests/calendar-ui-smoke.cjs
```

Google連携の初回設定と実機確認は `CALENDAR_SYNC.md` を参照してください。

Chromeでは、設定タブで次の2つの保存先を別々に選べます。

- 「iCloud DriveへJSON保存」：復元用の完全バックアップ `dashboard_sync.json`
- 「Google DriveへAI参照用JSON保存」：AIが読む案件専用ファイル `dashboard_cases.json`

以後は案件変更時に両方へ独立して自動上書きします。`dashboard_cases.json` には案件・連絡先・内部メモ・料金を含みますが、プロフィール、住所、口座情報、料金設定、Google認証情報は含みません。AIへ案件の確認を依頼するときは、接続済みのGoogle Driveにあるこの固定名のファイルを参照させてください。

別端末などによる外部更新を検知した保存先だけ自動保存を停止します。完全バックアップは画面の案内に従ってiCloud側を読み込むか保存先を再設定し、AI参照用ファイルはGoogle Drive側の保存先を再設定してください。

## 認証

GitHubへの初回pushでmacOSのキーチェーンやブラウザ認証が表示された場合は、本人がログイン・許可します。Googleカレンダー連携でもGoogleのログイン・同意だけは本人操作が必要です。パスワード、二要素認証コード、クライアントシークレットをチャットやリポジトリへ貼らないでください。
