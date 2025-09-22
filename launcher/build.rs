fn main() {
    // 仅在 Windows 下嵌入资源
    #[cfg(windows)]
    {
        embed_resource::compile("launcher.rc", embed_resource::NONE);
    }
}