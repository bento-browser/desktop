# diff

implementation of myers diff algorithm

[![Build Status](https://travis-ci.org/Swatinem/diff.png?branch=master)](https://travis-ci.org/Swatinem/diff)
[![Coverage Status](https://coveralls.io/repos/Swatinem/diff/badge.png?branch=master)](https://coveralls.io/r/Swatinem/diff)
[![Dependency Status](https://gemnasium.com/Swatinem/diff.png)](https://gemnasium.com/Swatinem/diff)

This uses the [_An O(ND) Difference Algorithm and Its Variations_](http://www.xmailserver.org/diff2.pdf)
Also see http://simplygenius.net/Article/DiffTutorial2 and
http://www.mathertel.de/Diff/ViewSrc.aspx for more inspiration

## Installation

    $ npm install diff
    $ component install Swatinem/diff

## Usage

### diff(a, b, [eql(a, b)])

Given two arrays (or array-likes, such as strings) `a` and `b` and an optional
equal function `eql`, this will return an array with the following operations:

- _nop_ the element is in both arrays
- _ins_ the element is only in array `b` and will be inserted
- _del_ the element in only in array `a` and will be removed
- _rep_ the element from `a` will be replaced by the element from `b`.
  This is essentially the same as a del+ins

## License

LGPLv3
