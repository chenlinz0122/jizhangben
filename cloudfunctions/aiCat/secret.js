// 本地私密配置：只在云函数里 require，不会被小程序端打包
// 优先用云开发控制台的环境变量 ZHIPU_API_KEY；没配环境变量时读这里
//
// 注意：这个文件里有明文 Key，别上传到公开的 git 仓库，也别发群里。
module.exports = {
  ZHIPU_API_KEY: 'a067cd2c01be48598423c90bd3814a3c.HL6M1N639n2EO2h5'
}
