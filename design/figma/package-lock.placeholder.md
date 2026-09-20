# 不单独锁定 Figma 插件依赖

插件依赖与根目录 npm lockfile 一起安装。`design/figma` 是 root workspace；根目录 `npm ci` 会安装 `@figma/plugin-typings` 与 `esbuild`。此文件仅防止将来误以为存在第二份锁文件。
