import type { NextApiRequest, NextApiResponse } from 'next'
import fs, { promises as fsPromise } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { getFirestore, doc, setDoc, collection, getCountFromServer } from 'firebase/firestore'
import { getFirebaseApp } from '../../../utils/firebase.config'
import { getOpenAIApiInstance } from '../../../utils/openai.config'

type Meme = {
  id: string;
  name: string;
  url: string;
  box_count: number;
  description: string;
}

async function retrieveMemesJsonFile(): Promise<Meme[]> {
  const memesJson = await fsPromise.readFile(path.join(process.cwd(), 'public', 'memes.json'), 'utf-8')
  return JSON.parse(memesJson)
}

type Data = {
  error?: string;
  memeUrl?: string;
  captions?: { text: string }[];
  invitation?: string;
}

/**
 * @description Chooses a random meme and asks ChatGPT to generate captions for it. Then, it makes a request to imgflip to create a meme based on the meme id and captions passed.
 * @param req Standard Next.js request
 * @param res Response contains meme url, captions, and invitation generated by ChatGPT
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'This type of request is not supported.' })
    return
  }

  if (!fs.existsSync(path.join(process.cwd(), 'public', 'memes.json'))) {
    res.status(500).json({ error: 'Unable to retrieve memes.' })
    return
  }

  const memes = await retrieveMemesJsonFile()
  let chosenMeme: Meme;

  do {
    // chose a meme that has a hand-written description because that gives ChatGPT more context
    chosenMeme = memes[Math.floor(Math.random() * memes.length)]
  } while (chosenMeme?.description === null);

  const openai = getOpenAIApiInstance()

  // generate the meme caption and invitation text using GPT-3
  const completion = await openai.createChatCompletion({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "user",
        content: `
        Can you write a meme-style statement for my BCOE gala pickup line? 
        In addition, can you write the ${chosenMeme.box_count} captions that go into the text boxes of the "${chosenMeme.name}" meme.
        The description of the meme is the following: "${chosenMeme.description}".
        Also, can you write the captions in the following format so that my script can easily retrieve it?
        The invitation (not the caption) can include hashtags and emojis if it makes it better!

        Caption[caption_number]: [caption]
        Invitation: [invitation]`,
      }],
  });

  const message = completion?.data?.choices[0]?.message?.content

  if (message === null || message === undefined || message === '') {
    res.status(500).json({ error: 'Unable to contact ChatGPT\'s servers.' })
    return
  }

  // captions within the string are seen right after the word "Caption[caption_number]:"
  const captionMatches = message.match(/Caption\[\d\]:\s(.*)/g) || message.match(/Caption\s\d\:\s(.*)/g) || message.match(/Caption\d\:\s(.*)/g) || []

  // split each caption into an array of 2 elements: [caption_number, caption]
  const captions = captionMatches.map((caption) => {
    const [, captionText] = caption.split(": ")
    return {
      text: captionText
    }
  })

  // invitation within the string is seen right after the word "Invitation: " or "Invitation:\n", or the text after the last colon
  const invitationMatch = message.match(/Invitation:\s(.*)/) || message.match(/Invitation:\n(.*)/) || []
  let invitation: string = (invitationMatch[0] || ": ").split(": ")[1]

  // if the invitation could not be found within the string, ChatGPT likely formatted it differently than usual
  // this is used as last resort to find the invitation
  if (invitationMatch.length === 0) {
    const lastColonIndex = message.lastIndexOf(':')
    // find the text after the last colon in message
    invitation = message.substring(lastColonIndex + 1)
  }

  // prepare the request body to imgFlip
  const body = new URLSearchParams()
  body.append('template_id', chosenMeme.id)
  body.append('username', process.env.IMGFLIP_USERNAME as string)
  body.append('password', process.env.IMGFLIP_PASSWORD as string)
  captions.forEach((caption: { text: string }, index: number) => {
    body.append(`boxes[${index}][text]`, caption.text)
  })

  const response = await fetch('https://api.imgflip.com/caption_image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    },
    body,
  });

  // if the request to imgFlip was unsuccessful, or if the invitation or captions could not be found, return an error
  // and log everything about this request
  if (!response.ok || invitation === undefined || invitation === null || invitation === '' || captions.length === 0) {
    console.log('------------------')
    console.log(`Meme: ${chosenMeme.name} (${chosenMeme.id})`)
    console.log(`Message: ${message}`)
    console.log(`Captions: ${JSON.stringify(captions)}`)
    console.log(`Invitation: ${invitation}`)
    console.error(`Error: ${response.statusText}`)
    console.log('------------------')

    res.status(500).json({ error: 'Unable to generate meme.' })
    return
  }

  const { app } = getFirebaseApp()
  const db = getFirestore(app)

  const coll = collection(db, "memes");
  const memeSnapshot = await getCountFromServer(coll);

  await setDoc(doc(db, "memes", uuidv4()), {
    imgFlipMemeId: chosenMeme.id,
    captions,
    invitation,
    created: new Date(),
    // random is the index of the meme in the memes collection
    // this is used so that a random meme can be retrieved from the database on the main page
    random: memeSnapshot.data().count,
  })

  const memeData = await response?.json()
  const memeUrl = memeData?.data?.url

  res.status(201).json({
    memeUrl,
    captions,
    invitation,
  })
}