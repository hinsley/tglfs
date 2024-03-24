from setuptools import setup, find_packages

setup(
    name='tgfs',
    version='0.1.0',
    packages=find_packages(),
    install_requires=[
        'python-telegram-bot',
    ],
    entry_points={
        'console_scripts': [
            'tgfs = tgfs.main:main',
        ],
    },
)
