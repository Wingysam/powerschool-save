import { PowerSchoolSave, PasswordLoginStrategy } from '.'

;(async () => {
  try {
    const pss = new PowerSchoolSave('https://mylearning.powerschool.com', 'output', {
      headless: true,
      maxTabs: 10
    })
    const loginStrategy = PasswordLoginStrategy.fromEnv()
    await pss.login(loginStrategy)
    await pss.saveClasses()
    process.exit()
  } catch (error) {
    if (error instanceof Error) console.log('Error:', error.message, error.stack)
    process.exit()
  }
})()