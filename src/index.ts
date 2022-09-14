import fs from 'node:fs/promises'
import path from 'node:path'
import timers from 'node:timers/promises'

import puppeteer from 'puppeteer'
import dotenv from 'dotenv'

class NotLoggedInError extends Error {}

dotenv.config()

function assertExists<T>(x: T): NonNullable<T> {
  if (typeof x === 'undefined' || x === null) throw new Error('Something that should exist does not.')
  return x as NonNullable<T>
}
function sanitizeFilename(text: string) {
  return text.replace(/[^a-z0-9\(\)\[\]\-, ]/gi, '_')
}

class Tabs {
  private tabs: puppeteer.Page[]
  private pending: ((tab: puppeteer.Page) => any)[]
  private browser: puppeteer.Browser
  private max: number
  count: number

  constructor (browser: puppeteer.Browser, max: number) {
    this.tabs = []
    this.pending = []
    this.browser = browser
    this.max = max
    this.count = 0
    
    ;(async () => {
      while (true) {
        await this.createPendingTabs()
        await timers.setTimeout(100)
      }
    })()
  }

  create (): Promise<puppeteer.Page> {
    return new Promise(resolve => {
      this.pending.push(resolve)
    })
  }

  private async createPendingTabs () {
    await this.cullDeadTabs()

    while (this.tabs.length < this.max) {
      const pending = this.pending.shift()
      if (!pending) return

      const tab = await this.browser.newPage()
      await tab.setViewport({ width: 1920, height: 1080 })
      this.tabs.push(tab)
      pending(tab)
      this.count++
    }
  }

  private async cullDeadTabs () {
    for (const [i, tab] of this.tabs.entries()) {
      if (tab.isClosed()) this.tabs.splice(i, 1)
    }
  }
}

abstract class LoginStrategy {
  abstract login (page: puppeteer.Page): Promise<void>
}

export class PasswordLoginStrategy extends LoginStrategy {
  private username: string
  private password: string

  constructor (username: string, password: string) {
    super()
    this.username = username
    this.password = password
  }

  static fromEnv() {
    if (!process.env.USERNAME) throw new Error('No USERNAME in environment.')
    if (!process.env.PASSWORD) throw new Error('No PASSWORD in environment.')

    return new this(process.env.USERNAME, process.env.PASSWORD)
  }

  async login (page: puppeteer.Page) {
    const username = assertExists(await page.waitForSelector('#login'))
    await username.type(this.username, { delay: 25 })
    const password = assertExists(await page.waitForSelector('#password'))
    await password.type(this.password, { delay: 25 })

    const button = assertExists(await page.waitForSelector('#loginsubmit'))
    button.click()

    const ERROR_TEXT = 'The username or password you entered is incorrect.'
    let note
    try {
      await page.waitForNavigation()
      note = await page.waitForSelector('#login_wrapper > div.note', { timeout: 1000 })
    } catch {}
    if (!note) return
    if (await note.evaluate((div: any) => div.innerText) === ERROR_TEXT) throw new Error(ERROR_TEXT)
  }
}

type PowerSchoolClassResolvable = {
  name: string
  url: string
}
export class PowerSchoolSave {
  private root: string
  private out: string
  private headless: boolean
  private maxTabs: number
  private tabs?: Tabs

  constructor (root: string, out: string, opts: { headless?: boolean, maxTabs?: number }) {
    this.root = root
    this.out = out
    this.headless = opts.headless !== false
    this.maxTabs = opts.maxTabs ?? 5
  }

  async login (strategy: LoginStrategy) {
    await fs.rm(this.out, { recursive: true })
    await fs.mkdir(this.out)
    const browser = await puppeteer.launch({ headless: this.headless })
    this.tabs = new Tabs(browser, this.maxTabs)
    
    const tab = await this.tabs.create()
    await tab.goto(this.root)
    await strategy.login(tab)
    await tab.close()
  }

  async saveClasses() {
    if (!this.tabs) throw new NotLoggedInError()
    
    const tab = await this.tabs.create()
    await tab.goto(this.root)
    await tab.waitForNavigation()
    const psClassElements = await tab.$$('.eclass_filter > a')
    const psClasses = await Promise.all(psClassElements.map(a => a.evaluate((a: any) => { return { name: a.innerText, url: a.href } }))) as PowerSchoolClassResolvable[]
    await tab.close()

    await Promise.all(psClasses.map(psClass => this.saveClass(psClass)))

    console.log(this.tabs.count, 'tabs total.')
  }

  async saveClass(psClass: PowerSchoolClassResolvable) {
    if (!this.tabs) throw new NotLoggedInError()

    const tab = await this.tabs.create()

    await tab.goto(psClass.url)
    const haikuContext = await tab.evaluate('HaikuContext')
    const classOut = path.join(this.out, sanitizeFilename(`${psClass.name} (${haikuContext.eclass.id})`))
    await fs.mkdir(classOut)

    const classRoot = (await tab.$eval('#cms_page_eclass_name > a', (a: any) => a.href)).replace(/\/cms_page\/view$/, '')

    await tab.close()

    await Promise.all([
      this.savePages(classOut, classRoot),
      this.saveMessages(classOut, classRoot),
      this.saveActivities(classOut, classRoot),
      this.saveGrades(classOut, classRoot)
    ])

    console.log('Saved', psClass.name)
  }

  async savePages(classOut: string, classRoot: string) {
    if (!this.tabs) throw new NotLoggedInError()

    const tab = await this.tabs.create()

    const pagesOut = path.join(classOut, 'Pages')
    await Promise.all([
      fs.mkdir(pagesOut),
      tab.goto(classRoot + '/cms_page/view')
    ])

    const pages = await tab.$$eval('ul#sm_0 a', (as: any[]) => as.map(a => { return { title: a.innerText, href: a.href } }))
    await tab.close()
    const padLength = `${pages.length}`.length

    function pad(number: number) {
      return `${number}`.padStart(padLength, '0')
    }

    await Promise.all(pages.map(async (page, i) => {
      while (true) {
        if (!this.tabs) throw new NotLoggedInError()
  
        const tab = await this.tabs.create()
  
        await tab.goto(page.href)
        await tab.evaluate('CmsPageComments.toggle({ direction: "expand" })')
        await tab.evaluate('setInterval(() => window.scrollBy(0, window.innerHeight), 100)')
        try {
          await tab.waitForSelector('div.stub', { hidden: true })
        } catch {
          await tab.close()
          continue
        }
  
        const pageOut = path.join(pagesOut, sanitizeFilename(`${pad(i)} ${page.title}`)) + '.pdf'
        if (this.headless) await tab.pdf({ path: pageOut, width: 1920, height: 1920 })
  
        await tab.close()
  
        console.log('Saved', page.title)
        return
      }
    }))
  }

  async saveMessages(classOut: string, classRoot: string) {
    const messages = path.join(classOut, 'Messages')
    await fs.mkdir(messages)

    await Promise.all([
      this.saveMessagesInbox(messages, classRoot),
      this.saveMessagesDrafts(messages, classRoot)
    ])
  }

  async saveMessagesInbox(messagesOut: string, classRoot: string) {
    if (!this.tabs) throw new NotLoggedInError()

    const inboxOut = path.join(messagesOut, 'Inbox')
    await fs.mkdir(inboxOut)

    const tab = await this.tabs.create()

    await tab.goto(classRoot + '/inbox')
    for (const message of await tab.$$('#inbox_table td > a')) {
      await message.click()
      const titleTd = assertExists(await tab.waitForSelector('.message_info > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(2)'))
      const dateTd = assertExists(await tab.waitForSelector('.message_info > table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(4) > td:nth-child(2)'))
      const close = assertExists(await tab.waitForSelector('[value="Close"]', { visible: true }))
      
      const title = await titleTd.evaluate((td: any) => td.innerText)
      const date = new Date(await dateTd.evaluate((td: any) => td.innerText))

      const messageOut = path.join(inboxOut, sanitizeFilename(`${date.toISOString()} ${title}`) + '.pdf')
      if (this.headless) await tab.pdf({ path: messageOut, width: 1920, height: 1920 })

      await close.click()

      console.log('Saved', title)
    }

    await tab.close()
  }

  async saveMessagesDrafts(messagesOut: string, classRoot: string) {
    if (!this.tabs) throw new NotLoggedInError()

    const draftsOut = path.join(messagesOut, 'Drafts')
    await fs.mkdir(draftsOut)

    const tab = await this.tabs.create()

    await tab.goto(classRoot + '/inbox/drafts')
    for (const message of await tab.$$('#inbox_table td > a')) {
      await message.click()
      const titleBox = assertExists(await tab.waitForSelector('#tb_subject'))
      const idBox = assertExists(await tab.waitForSelector('#tb_inbox_message_id'))
      const close = assertExists(await tab.waitForSelector('#TB_closeAjaxWindow', { visible: true }))
      await tab.waitForSelector('#cke_2_toolbox', { visible: true })
      
      const title = await titleBox.evaluate((td: any) => td.value)
      const id = await idBox.evaluate((td: any) => td.value)

      const messageOut = path.join(draftsOut, sanitizeFilename(`${title} (${id})`) + '.pdf')
      if (this.headless) await tab.pdf({ path: messageOut, width: 1920, height: 1920 })

      await close.click()

      console.log('Saved', title)
    }

    await tab.close()
  }

  async saveActivities (classOut: string, classRoot: string) {
    const activitiesOut = path.join(classOut, 'Activities')
    await fs.mkdir(activitiesOut)
    
    await Promise.all([
      this.saveActivitiesAssignments(activitiesOut, classRoot),
      this.saveActivitiesDiscussions(activitiesOut, classRoot)
    ])
  }
  
  async saveActivitiesAssignments (activitiesOut: string, classRoot: string, page?: number) {
    if (!this.tabs) throw new NotLoggedInError()
    if (!page) page = 1
    
    const assignmentsOut = path.join(activitiesOut, 'Assignments')
    if (page === 1) await fs.mkdir(assignmentsOut)

    const tab = await this.tabs.create()
    await tab.goto(`${classRoot}/assignment?page=${page}`)
    const assignments = await tab.$$('#assignment_list td:nth-child(1) > a')
    const hasNextPage = await tab.$('.nextpage.next')
    
    let nextPage
    if (hasNextPage) nextPage = this.saveActivitiesAssignments(activitiesOut, classRoot, page + 1)
    const promises = []
    for (const assignment of assignments) {
      const title = await assignment.evaluate((a: any) => a.innerText)
      await assignment.click()
      const close = assertExists(await tab.waitForSelector('input.button[value="Close"]', { visible: true }))
      const assignmentOut = path.join(assignmentsOut, sanitizeFilename(`${title}`) + '.pdf')
      if (this.headless) await tab.pdf({ path: assignmentOut, width: 1920, height: 1920 })
      
      const viewWork = await tab.$('#tb_handin_button + a')
      if (viewWork) {
        const href = await viewWork.evaluate((a: any) => a.href)
        promises.push(this.saveActivitiesAssignmentWork(assignmentsOut, title, href))
      }

      await close.click()
      console.log('Saved', title)
    }
    await tab.close()
    await Promise.all(promises)
    await nextPage
  }

  async saveActivitiesAssignmentWork (assignmentsOut: string, title: string, href: string) {
    if (!this.tabs) throw new NotLoggedInError()

    const tab = await this.tabs.create()
    await tab.goto(href)
    await tab.waitForSelector('#TB_ajaxContent', { visible: true })

    const workOut = path.join(assignmentsOut, sanitizeFilename(`${title} (Work)`) + '.pdf')
    if (this.headless) await tab.pdf({ path: workOut, width: 1920, height: 1920 })

    await tab.close()

    console.log('Saved', title, 'Work')
  }

  async saveActivitiesDiscussions (activitiesOut: string, classRoot: string) {
    if (!this.tabs) throw new NotLoggedInError()
    const tab = await this.tabs.create()
    await tab.goto(`${classRoot}/discussion`)

    const discussionsOut = path.join(activitiesOut, 'Discussions')
    await fs.mkdir(discussionsOut)

    const discussions = await tab.$$('#dsc_list td:nth-child(1) > a:nth-child(1)')

    const padLength = `${discussions.length}`.length
    function pad(number: number) {
      return `${number}`.padStart(padLength, '0')
    }

    for (const [i, discussion] of discussions.entries()) {
      await discussion.click()
      await tab.waitForSelector('.thread_item')
      await tab.waitForSelector('#dsc_close_btn', { visible: true })

      const title = await (assertExists(await tab.waitForSelector('h3'))).evaluate((el: any) => el.textContent)
      const discussionOut = path.join(discussionsOut, sanitizeFilename(`${pad(i + 1)} ${title}`))
      await fs.mkdir(discussionOut)

      const threads = await tab.$$('#thread_list > .thread_item')
      for (const thread of threads) {
        const op = await thread.$eval('.name', (el: any) => el.textContent)
        await thread.click()
        await tab.waitForSelector('#dsc_thread_tbar', { hidden: true })
        await tab.waitForSelector('#dsc_thread_tbar', { visible: true })
        const viewAll = await tab.$('#dsc_all_posts')
        if (viewAll) {
          await tab.click('#dsc_all_posts > a')
          await tab.waitForSelector('#dsc_all_posts > img', { visible: true })
          await tab.waitForSelector('#dsc_all_posts > img', { hidden: true })
          await tab.waitForSelector('#dsc_all_posts', { hidden: true })
        }

        const threadOut = path.join(discussionOut, sanitizeFilename(`${op}`)) + '.pdf'
        if (this.headless) await tab.pdf({ path: threadOut, width: 1920, height: 1920 })
        console.log('Saved', title, op)
      }

      await tab.click('#dsc_close_btn')
    }

    await tab.close()
  }

  async saveGrades(classOut: string, classRoot: string) {
    if (!this.tabs) throw new NotLoggedInError()
    const tab = await this.tabs.create()
    await tab.goto(`${classRoot}/grades`)

    await tab.waitForSelector('.brubrics', { hidden: true })

    const gradebooksOut = path.join(classOut, 'Gradebooks') + '.pdf'
    if (this.headless) await tab.pdf({ path: gradebooksOut, width: 1920, height: 1920 })
    console.log('Saved gradebooks')

    await tab.close()
  }
}
