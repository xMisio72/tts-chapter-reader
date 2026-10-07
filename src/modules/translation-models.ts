/**
 * Translation models the plugin can download: Opus-MT (Helsinki-NLP, CC-BY 4.0)
 * converted to ONNX by Xenova. One model per source language into English;
 * `mul` is the many-languages model used for everything without its own.
 *
 * Pinned to exact commits with SHA-256 for every file, like the voice. The
 * list is generated from the Hugging Face API (scratch script, 2026-10-07);
 * edit the numbers only by regenerating.
 */

export interface ModelFile {
  /** Path inside the repository. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface TranslationModel {
  /** Source language (ISO 639-1), or `mul` for the many-languages model. */
  lang: string;
  /** Shown to the user, e.g. "German". */
  name: string;
  repo: string;
  revision: string;
  files: ModelFile[];
}

export const TRANSLATION_MODELS: TranslationModel[] = [
  {
    lang: 'de',
    name: 'German',
    repo: 'Xenova/opus-mt-de-en',
    revision: '399dfd68706739fffd503f876093e455ae268a06',
    files: [
      { path: 'config.json', bytes: 1376, sha256: '6754743ec4754957d8552dad869d1314f3af6626b67446ec4cebe5e2fbaa0fc4' },
      { path: 'generation_config.json', bytes: 293, sha256: 'cd16a899388283889c6e87b903c689ce73430aaa18335415f9d9ea770606538e' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 56652404, sha256: '4712800584b2d77c2f9e620bf29523e2b20b62f65ade5011ee01780e2b0ea5d3' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 49366942, sha256: '4cedda8f8c89b72a42b3c6cd1e7a27f2de24457093e3bf80cb3e46829641fcd8' },
      { path: 'tokenizer.json', bytes: 5498450, sha256: '8e0fcf45621ea87fa680c7f9969c37a7f819c1f4c7658a2e6e0879b866a14b17' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: 'e3687c40400600366d9b073a3fd9f75dc8b40d5a9d6e5c92544cf2e9592abe6c' },
    ],
  },
  {
    lang: 'fr',
    name: 'French',
    repo: 'Xenova/opus-mt-fr-en',
    revision: '6b166a182780e118c997879d0ad5be4b53671644',
    files: [
      { path: 'config.json', bytes: 1411, sha256: '6c2851f154d7b88c7767e4fdcf8a5694a36a456bfa6cbcde1b13fdbade3b56f6' },
      { path: 'generation_config.json', bytes: 293, sha256: 'f9a4824ec78c61b4a95afc43bbb6a9545a44ccf1c01d0963a286e799b9e7b256' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 57381512, sha256: '73bc7ac8e29c42e6f212ebcc29a2991d3646a04aabb642c0036aa54b40e4e1a9' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 50090398, sha256: 'e727cb26ac6bf816394c49671af69c9ae5798868fed1e40849872415dffc1772' },
      { path: 'tokenizer.json', bytes: 5637839, sha256: '8391785c1a2139e7af4678571ccd8dc654ecbb72e4be186940f65d7c604f0246' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: 'bba9e6b1e3b9724d15ebacaf11eaac360c5ae3f4139bcdef0ee1610592eaa3fe' },
    ],
  },
  {
    lang: 'es',
    name: 'Spanish',
    repo: 'Xenova/opus-mt-es-en',
    revision: 'eadfd7c658a9d8929ac3b8e996b68a68e2c7d480',
    files: [
      { path: 'config.json', bytes: 1433, sha256: 'fab3a7f93185bc5aa7b419f6a1e6e74d98c8f2a506c94493d3019bf46da3478d' },
      { path: 'generation_config.json', bytes: 293, sha256: 'b743baabb7da4c1a2f19fe558bd6b4c0c7c3b0762fcb5ca7a48fe5a2c2219803' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 60212804, sha256: '4cd91ab30240d295ce907b5100826031838c672005e57e524d711122d75605fa' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 52899742, sha256: 'c01e70f8455efc350831aa2af7ed187b16829241f0018ba07d1ba643a391bc18' },
      { path: 'tokenizer.json', bytes: 6262682, sha256: '285eb29e7155ee48851a77960797813f86a125f70d2c1a124f613f1fbd2b19c3' },
      { path: 'tokenizer_config.json', bytes: 282, sha256: 'e1fac15a910169d5b5ec07a13b0374273626a239b5142db10be229ca66cc52a9' },
    ],
  },
  {
    lang: 'it',
    name: 'Italian',
    repo: 'Xenova/opus-mt-it-en',
    revision: 'fd0b89b9c052adc1f2f64152f555aa17353728be',
    files: [
      { path: 'config.json', bytes: 1376, sha256: '4b82a23b7a91b213a934db70d0a33712a739fdd7c5686b02d89642d7dcfc7ac4' },
      { path: 'generation_config.json', bytes: 293, sha256: 'bab9fcae043547da07e13c701f77cf55b6b1517d6f73848c5c4476e7255da512' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 68147852, sha256: 'aebc2789cd2ef8062fbda020bac90b61e68458ba98a4c43cea63c1d2310ba2b8' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 60773278, sha256: 'a025d2d85c90da23880116b67175e43e71921d8d2bf446b9f1eacdc86015aa4c' },
      { path: 'tokenizer.json', bytes: 7942314, sha256: 'c19e1dac8287ec5c5d47a0d81be5e0fd11755666b996c764ef4d13bb8117e3a2' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: 'b0039f5c755ca180319fc4cd689398a62cd4a67042538158271f199437f0cccd' },
    ],
  },
  {
    lang: 'nl',
    name: 'Dutch',
    repo: 'Xenova/opus-mt-nl-en',
    revision: '82c42d95d1508037cbe7172d85fd4e940a2f3584',
    files: [
      { path: 'config.json', bytes: 1376, sha256: 'e03f36d5475954f1c09b08d0da68d6ea06a051e299a399e740554ed768d2a99c' },
      { path: 'generation_config.json', bytes: 293, sha256: 'b11b1ae60dbb7656d021197a8883e81004dbdb74652df9d113f2efe2ca0dd974' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 61258736, sha256: 'ad4df9a08f16952c0d9ee06807f54d62fcd07a9109c2c0b8ea05a4422d7bf4d7' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 53937566, sha256: '7b8b1e9071bed8e2394e3bd2f65b952700b1dd1293d087141134c8bac018653b' },
      { path: 'tokenizer.json', bytes: 6433167, sha256: 'c6b55d9ac70b2a566f0307c6f80d3136fb839ed8e70bb16186324747df58668b' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: '7e7b5a6712709169fe3bcd7fe1bfb851310e09b4ef70a7e39b176de30e420657' },
    ],
  },
  {
    lang: 'ru',
    name: 'Russian',
    repo: 'Xenova/opus-mt-ru-en',
    revision: 'afe8c6c738ec81b6d033fd8f44f9678a639a7c67',
    files: [
      { path: 'config.json', bytes: 1376, sha256: '60dc7d0906dbe42a1d740cdd7e84ce1534685b81fbe16005a0301adac69086ce' },
      { path: 'generation_config.json', bytes: 293, sha256: '9bcb507fa6117b07870df6627294b878b0710a55bc3abc9cf0db980e0c48fe2c' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 58931576, sha256: '25e7ff97b201bce64ab9c39749761d657b70b8602bcbc1ce01c67f713e90ffdf' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 51628446, sha256: 'c10df0466540534bb70c4402d539c349b8bfa9968184cad89f51408cf13e7eb7' },
      { path: 'tokenizer.json', bytes: 7205388, sha256: '981cd3d9fef6bb4dda8082afda716b65deb6717cb3ef35ac0b57002c09dec2bb' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: 'c0710ba5ee70ccb2d0e6b0092139d00f370b9c4783c4b077584cb3cc8f7ac4e0' },
    ],
  },
  {
    lang: 'pl',
    name: 'Polish',
    repo: 'Xenova/opus-mt-pl-en',
    revision: 'aeaf0e003b045248c28a559a5ce6027b54ebdaba',
    files: [
      { path: 'config.json', bytes: 1376, sha256: '98ccffdad4d25169e4621b05b70824b93855fcc1ac9e917a6faef0ead4d6c799' },
      { path: 'generation_config.json', bytes: 293, sha256: '58d0f9d875ca857930d2e8425c7dd093eef4799d56e6ca94bc067650d001248d' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 59402168, sha256: '9ad9da5bce473ca06a9b0a3dbf0793675827e5668ab501e5dc65dac8cecd93ba' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 52095390, sha256: '2416eb3c6db52a2d116539bf673b596e6a3d1453153b17778e85c9f55249c832' },
      { path: 'tokenizer.json', bytes: 6118576, sha256: '788e7e69a1dcb862ced197e440581bfcb672b37173dd0c5ff55649c7c8394f74' },
      { path: 'tokenizer_config.json', bytes: 280, sha256: 'd29a00bce5fa370984ef9bd8c612625b90d9a4843cffd27c067fde320080dfe0' },
    ],
  },
  {
    lang: 'mul',
    name: 'Other languages',
    repo: 'Xenova/opus-mt-mul-en',
    revision: '72a05e47cee89c718a9db4dc70d02fef3bc39de8',
    files: [
      { path: 'config.json', bytes: 1390, sha256: '115093532b9893a6e3ec64951db15bafbad200f34929304f9570c3cd7f1dff94' },
      { path: 'generation_config.json', bytes: 293, sha256: '66300b2138c7a98fe085d16b590ecbc01d64d46e9db240ee3dab4eadd3a3b1b9' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 59785040, sha256: '6add167a0cd3f78aa298b8f927d2e8645e33cb17df11e92967f0c5b5703c8c4d' },
      { path: 'onnx/encoder_model_quantized.onnx', bytes: 52475294, sha256: '5ce609a524375dbdd9c66b62b82b41abc667799022667ce424f20c245bd56925' },
      { path: 'tokenizer.json', bytes: 6089424, sha256: '7ae61d18c438de0cf069a5cd25edc0d9d899353d710bf0e774819f97201049b9' },
      { path: 'tokenizer_config.json', bytes: 282, sha256: '0e5fceb4caf753096870f0a74ec2a0a9825327cefd1cc06e0b8dc71e75257cf7' },
    ],
  },
];
